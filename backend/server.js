// server.js — API RPPS (multi-etapas) c/ idempotência em /api/gerar-termo
// Lê CNPJ_ENTE_UG, Dados_REP_ENTE_UG, CRP (colunas fixas B/F/G = 1/5/6),
// grava em Termos_registrados (com coluna IDEMP_KEY para idempotência)
// e registra alterações em Reg_alteracao_dados_ente_ug (auto-cria se faltar)
// Também dá suporte a “upsert” de representantes (CPF não encontrado) e de base CNPJ (CNPJ não encontrado)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const http = require('http');
const https = require('https');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();

/* ───────────── Conexões/robustez ───────────── */
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

const CACHE_TTL_MS       = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const CACHE_TTL_CRP_MS   = Number(process.env.CACHE_TTL_CRP_MS || 2 * 60 * 1000);

const SHEETS_CONCURRENCY  = Number(process.env.SHEETS_CONCURRENCY || 3);
const SHEETS_TIMEOUT_MS   = Number(process.env.SHEETS_TIMEOUT_MS || 20_000);
const SHEETS_RETRIES      = Number(process.env.SHEETS_RETRIES || 2);

/* ───────────── Segurança ───────────── */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* util env list */
const splitList = (s = '') =>
  s.split(/[\s,]+/)
   .map(v => v.trim().replace(/\/+$/, ''))
   .filter(Boolean);

/* ───────────── CORS (robusto) ───────────── */
const ALLOW_LIST = new Set(
  splitList(process.env.CORS_ORIGIN_LIST || process.env.CORS_ORIGIN || '')
    .map(u => u.replace(/\/+$/, '').toLowerCase())
);

function isAllowedOrigin(origin) {
  if (!origin) return true; // requests internas / curl / same-origin
  const o = origin.replace(/\/+$/, '').toLowerCase();

  if (ALLOW_LIST.size === 0) return true;     // sem lista => libera em dev
  if (ALLOW_LIST.has(o)) return true;         // match exato

  // libera subdomínios do Netlify se a raiz específica estiver na lista
  if (/^https:\/\/.+\.netlify\.app$/i.test(o) &&
      ALLOW_LIST.has('https://programa-de-regularidade.netlify.app')) {
    return true;
  }
  return false;
}

const corsOptionsDelegate = (req, cb) => {
  const originIn = (req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
  const ok = isAllowedOrigin(originIn);

  // log de depuração só para /api
  if (req.path.startsWith('/api/')) {
    console.log(`CORS ▶ ${originIn || '(sem origin)'} → ${ok ? 'ALLOW' : 'DENY'} | ALLOW_LIST=[${[...ALLOW_LIST].join(', ')}]`);
  }

  // sanitiza headers do preflight
  const reqHdrs = String(req.headers['access-control-request-headers'] || '')
    .replace(/[^\w\-_, ]/g, '');

  cb(null, {
    origin: ok ? (originIn || true) : false,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: reqHdrs || 'Content-Type,Authorization,Cache-Control,X-Idempotency-Key',
    exposedHeaders: ['Content-Disposition'],
    credentials: false,
    optionsSuccessStatus: 204,
  });
};

app.use(cors(corsOptionsDelegate));
app.options(/.*/, cors(corsOptionsDelegate));

/* ───────────── Helmet + demais middlewares ───────────── */
const connectExtra = splitList(process.env.CORS_ORIGIN || process.env.CORS_ORIGIN_LIST || '');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc:  ["'self'","https://cdn.jsdelivr.net","https://cdnjs.cloudflare.com","'unsafe-inline'"],
    styleSrc:   ["'self'","https://cdn.jsdelivr.net","https://fonts.googleapis.com","https://fonts.cdnfonts.com","'unsafe-inline'"],
    fontSrc:    ["'self'","https://fonts.gstatic.com","https://fonts.cdnfonts.com","data:"],
    imgSrc:     ["'self'","data:","blob:"],
    connectSrc: ["'self'", ...connectExtra],
    workerSrc:  ["'self'","blob:"],
    objectSrc:  ["'none'"],
    frameSrc:   ["'none'"],
    frameAncestors: ["'none'"],
    baseUri:    ["'self'"],
    formAction: ["'self'"],
  },
}));

app.use(rateLimit({ windowMs: 15*60*1000, max: 400, standardHeaders: true, legacyHeaders: false }));
app.use(hpp());
app.use(express.json({ limit: '300kb' }));

/* ───────────── Cache-Control das rotas de API ───────────── */
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  next();
});

/* ───────────── Static ───────────── */
const FRONTEND_DIR = path.join(__dirname, '../frontend');
app.use('/', express.static(FRONTEND_DIR));

/* pequenos utilitários para evitar 404 no console do PDF */
function trySendStatic(res, relPath) {
  const abs = path.join(FRONTEND_DIR, relPath);
  if (fs.existsSync(abs)) return res.sendFile(abs);
  return null;
}
app.get(['/favicon.ico','/favicon.png'], (req, res) => {
  if (trySendStatic(res, 'favicon.ico')) return;
  if (trySendStatic(res, 'favicon.png')) return;
  res.status(204).end(); // evita 404 no headless
});
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow:\n');
});

/* ───────────── Google Sheets ───────────── */
const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) {
  console.error('❌ Defina SHEET_ID no .env');
  process.exit(1);
}

// credenciais: arquivo ou base64
let creds;
if (process.env.GOOGLE_CREDENTIALS_B64) {
  try {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
  } catch {
    console.error('❌ GOOGLE_CREDENTIALS_B64 inválido.');
    process.exit(1);
  }
} else {
  const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH || 'credentials.json');
  if (!fs.existsSync(credsPath)) {
    console.error(`❌ credentials.json não encontrado em ${credsPath}`);
    process.exit(1);
  }
  creds = require(credsPath);
}

const doc = new GoogleSpreadsheet(SHEET_ID);

let _sheetsReady = false;
let _lastLoadInfo = 0;

/* ───────────── Utils ───────────── */
const norm   = v => (v ?? '').toString().trim();
const low    = v => norm(v).toLowerCase();
const digits = v => norm(v).replace(/\D+/g,'');
// >>> NOVO: normalizador consistente para CNPJ (sempre 14 dígitos, preserva zeros à esquerda)
const cnpj14 = v => digits(v).padStart(14, '0').slice(-14);

function nowBR(){
  const tz = 'America/Sao_Paulo';
  const d = new Date();
  return {
    DATA: d.toLocaleDateString('pt-BR',{ timeZone: tz }),
    HORA: d.toLocaleTimeString('pt-BR',{ timeZone: tz, hour12: false }),
    ANO:  d.getFullYear(),
    MES:  String(d.getMonth()+1).padStart(2,'0')
  };
}

function esferaFromEnte(ente){
  return low(ente).includes('governo do estado') ? 'Estadual/Distrital' : 'RPPS Municipal';
}

async function getSheetStrict(title){
  const s = doc.sheetsByTitle[title];
  if (!s) throw new Error(`Aba '${title}' não encontrada.`);
  return s;
}

async function getOrCreateSheet(title, headerValues){
  let s = doc.sheetsByTitle[title];
  if (s) return s;
  console.warn(`⚠️  Aba '${title}' não encontrada. Criando…`);
  s = await doc.addSheet({ title, headerValues });
  return s;
}

/* ───── Helpers (headers duplicados) ───── */
async function getRowsViaCells(sheet) {
  await sheet.loadHeaderRow();

  const normStr = v => (v ?? '').toString().trim();
  const sanitize = s =>
    normStr(s)
      .toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/_+/g, '_').replace(/^_+|_+$/g, '');

  const rawHeaders = (sheet.headerValues || []).map(h => normStr(h));
  const seen = {};
  const headersUnique = rawHeaders.map(h => {
    const base = sanitize(h);
    if (!base) return '';
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] === 1 ? base : `${base}__${seen[base]}`;
  });

  const cols = headersUnique.length || sheet.columnCount || 26;
  const endRow = sheet.rowCount || 2000;

  await sheet.loadCells({
    startRowIndex: 1,
    startColumnIndex: 0,
    endRowIndex: endRow,
    endColumnIndex: cols
  });

  const rows = [];
  for (let r = 1; r < endRow; r++) {
    let empty = true;
    const obj = {};
    for (let c = 0; c < cols; c++) {
      const key = headersUnique[c]; if (!key) continue;
      const cell = sheet.getCell(r, c);
      const val = cell?.value ?? '';
      if (val !== '' && val !== null) empty = false;
      obj[key] = val === null ? '' : String(val);
    }
    if (!empty) rows.push(obj);
  }
  return rows;
}

async function getRowsSafe(sheet) {
  try {
    return await sheet.getRows();
  } catch (e) {
    if (String(e?.message || '').toLowerCase().includes('duplicate header')) {
      return await getRowsViaCells(sheet);
    }
    throw e;
  }
}

/* ===== Concorrência + Timeout/Retry + Cache (Sheets) ===== */
const _q = [];
let _active = 0;
function _runNext() {
  if (_active >= SHEETS_CONCURRENCY) return;
  const it = _q.shift();
  if (!it) return;
  _active++;
  (async () => {
    try { it.resolve(await it.fn()); }
    catch (e) { it.reject(e); }
    finally { _active--; _runNext(); }
  })();
}
function withLimiter(tag, fn) {
  return new Promise((resolve, reject) => {
    _q.push({ fn, resolve, reject, tag });
    _runNext();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withTimeoutAndRetry(label, fn) {
  let attempt = 0;
  const max = SHEETS_RETRIES + 1;
  while (true) {
    attempt++;
    try {
      const run = fn();
      const guard = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout:${label}`)), SHEETS_TIMEOUT_MS)
      );
      return await Promise.race([run, guard]);
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      const code = String(err?.code || '').toLowerCase();
      const retriable =
        code === '429' ||
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('etimedout') ||
        msg.includes('timeout') ||
        msg.includes('socket hang up') ||
        msg.includes('econnreset') ||
        msg.includes('eai_again');

      if (!retriable || attempt >= max) throw err;
      const backoff = 300 * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }
}
async function safeGetRows(sheet, label) {
  return withLimiter(`${label || sheet.title}:getRows`, () =>
    withTimeoutAndRetry(`${label || sheet.title}:getRows`, () => getRowsSafe(sheet))
  );
}
async function safeLoadCells(sheet, opts, label) {
  return withLimiter(`${label || sheet.title}:loadCells`, () =>
    withTimeoutAndRetry(`${label || sheet.title}:loadCells`, () => sheet.loadCells(opts))
  );
}
async function safeAddRow(sheet, data, label) {
  return withLimiter(`${label || sheet.title}:addRow`, () =>
    withTimeoutAndRetry(`${label || sheet.title}:addRow`, () => sheet.addRow(data))
  );
}
async function safeSaveRow(row, label) {
  return withLimiter(`${label || 'row'}:save`, () =>
    withTimeoutAndRetry(`${label || 'row'}:save`, () => row.save())
  );
}
const _cache = new Map();
function cacheGet(key) {
  const it = _cache.get(key);
  if (it && it.exp > Date.now()) return it.data;
  _cache.delete(key); return null;
}
function cacheSet(key, data, ttl = CACHE_TTL_MS) {
  _cache.set(key, { data, exp: Date.now() + ttl });
}

/* ───── Datas ───── */
function parseDMYorYMD(s) {
  const v = norm(s);
  if (!v) return new Date(0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v+'T00:00:00');
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  const d = new Date(v);
  return isNaN(d) ? new Date(0) : d;
}
const formatDateDMY = d => {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
};
const formatDateISO = d => {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${yy}-${mm}-${dd}`;
};

/* ───── Leitura CRP (B/F/G = 1/5/6) ───── */
async function readCRPByFixedColumns(sheet) {
  const colCNPJ = 1, colVal = 5, colDec = 6; // 0-based
  const endRow = sheet.rowCount || 2000;
  const endCol = Math.max(colCNPJ, colVal, colDec) + 1;

  await safeLoadCells(sheet, { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol }, 'CRP:loadCells');

  const rows = [];
  for (let r = 1; r < endRow; r++) {
    const cnpjCell = sheet.getCell(r, colCNPJ);
    const valCell  = sheet.getCell(r, colVal);
    const decCell  = sheet.getCell(r, colDec);

    const cnpj = digits(cnpjCell?.value ?? '');

    let validadeDMY = '';
    let validadeISO = '';

    const fv = valCell?.formattedValue;
    if (fv && /^\d{2}\/\d{2}\/\d{4}$/.test(String(fv))) {
      validadeDMY = String(fv);
      const [dd,mm,yy] = validadeDMY.split('/');
      validadeISO = `${yy}-${mm}-${dd}`;
    } else if (valCell?.value instanceof Date) {
      validadeDMY = formatDateDMY(valCell.value);
      validadeISO = formatDateISO(valCell.value);
    } else if (typeof valCell?.value === 'number') {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + valCell.value * 86400000);
      validadeDMY = formatDateDMY(d);
      validadeISO = formatDateISO(d);
    } else if (typeof valCell?.value === 'string') {
      validadeDMY = valCell.value;
      const m = validadeDMY.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) validadeISO = `${m[3]}-${m[2]}-${m[1]}`;
    }

    const decisao  = norm(decCell?.formattedValue ?? decCell?.value ?? '');

    if (!cnpj && !validadeDMY && !decisao) continue;
    rows.push({ CNPJ_ENTE: cnpj, DATA_VALIDADE_DMY: validadeDMY, DATA_VALIDADE_ISO: validadeISO, DECISAO_JUDICIAL: decisao });
  }
  return rows;
}

/* Cache específico para CRP */
let _crpMemo = { data: null, exp: 0 };
async function getCRPAllCached(sheet, skipCache = false) {
  if (!skipCache && _crpMemo.exp > Date.now() && _crpMemo.data) return _crpMemo.data;
  const rows = await withLimiter('CRP:read', () =>
    withTimeoutAndRetry('CRP:read', () => readCRPByFixedColumns(sheet))
  );
  _crpMemo = { data: rows, exp: Date.now() + CACHE_TTL_CRP_MS };
  return rows;
}


/* ─────────────── PUPPETEER (robust) ─────────────── */
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || path.resolve(__dirname, '.puppeteer');
process.env.TMPDIR = process.env.TMPDIR || '/tmp';

function findChromeIn(dir) {
  try {
    if (!fs.existsSync(dir)) return null;
    const chromeDir = path.join(dir, 'chrome');
    if (!fs.existsSync(chromeDir)) return null;
    const platforms = fs.readdirSync(chromeDir).filter(n => n.startsWith('linux-'));
    for (const p of platforms) {
      const candidate = path.join(chromeDir, p, 'chrome-linux64', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) {}
  return null;
}

let _browserPromise;
async function getBrowser() {
  if (!_browserPromise) {
    // ordem de resolução: ENV → .puppeteer local → puppeteer.executablePath()
    const localPuppeteerDir = path.resolve(__dirname, '.puppeteer');
    const altBackendDir = path.resolve(__dirname, '../backend/.puppeteer'); // caso rode de outra pasta
    const resolved =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      findChromeIn(localPuppeteerDir) ||
      findChromeIn(altBackendDir);

    // fallback para API do pacote (pode retornar vazio se não baixou no postinstall)
    const byApi = (() => {
      try { return require('puppeteer').executablePath(); } catch { return null; }
    })();

    const chromePath = resolved || byApi;
    console.log('🔎 Chrome path (resolved):', chromePath || '(none)');

    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new Error(`Chrome não encontrado. Ajuste build para baixar em ".puppeteer" ou defina PUPPETEER_EXECUTABLE_PATH. Tentado: ${chromePath || '(vazio)'}`);
    }

    _browserPromise = puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none'
      ],
      timeout: 60_000
    }).then(browser => {
      browser.on('disconnected', () => {
        console.warn('⚠️  Puppeteer desconectado — resetando instância.');
        _browserPromise = null;
      });
      return browser;
    });
  }
  return _browserPromise;
}


/* ─────────────── ROTAS ─────────────── */

async function authSheets() {
  return withLimiter('authSheets', async () =>
    withTimeoutAndRetry('authSheets', async () => {
      if (!_sheetsReady) {
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();
        _sheetsReady = true;
        _lastLoadInfo = Date.now();
        return;
      }
      if (Date.now() - _lastLoadInfo > 10 * 60 * 1000) {
        try { await doc.loadInfo(); _lastLoadInfo = Date.now(); } catch (_) {}
      }
    })
  );
}

app.get('/api/health', (_req,res)=> res.json({ ok:true }));
app.get('/api/healthz', (_req,res)=> {
  res.json({ ok:true, uptime: process.uptime(), ts: Date.now() });
});

/** GET /api/consulta?cnpj=NNNNNNNNNNNNNN[&nocache=1] */
app.get('/api/consulta', async (req, res) => {
  try {
    // >>> usa normalização de 14 dígitos para preservar zeros à esquerda
    const cnpj = cnpj14(req.query.cnpj || '');
    if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });

    const skipCache = Object.prototype.hasOwnProperty.call(req.query, 'nocache');

    const cacheKey = `consulta:${cnpj}`;
    if (!skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ok: true, data: cached, missing: false });
    }

    await authSheets();

    const sCnpj = await getSheetStrict('CNPJ_ENTE_UG');
    const sReps = await getSheetStrict('Dados_REP_ENTE_UG');
    const sCrp  = await getSheetStrict('CRP');

    const cnpjRows = await safeGetRows(sCnpj, 'CNPJ:getRows');
    // >>> comparação por CNPJ normalizado (evita erro com zeros à esquerda)
    let base = cnpjRows.find(r => cnpj14(getVal(r,'CNPJ_ENTE')) === cnpj);
    if (!base) base = cnpjRows.find(r => cnpj14(getVal(r,'CNPJ_UG')) === cnpj);
    if (!base) {
      console.warn(`[consulta] CNPJ ${cnpj} não encontrado em CNPJ_ENTE_UG`);

      const out = {
        UF: '', ENTE: '',
        CNPJ_ENTE: cnpj,
        UG: '', CNPJ_UG: '',
        EMAIL_ENTE: '', EMAIL_UG: '',
        CRP_DATA_VALIDADE_DMY: '', CRP_DATA_VALIDADE_ISO: '',
        CRP_DECISAO_JUDICIAL: '',
        ESFERA_SUGERIDA: '',
        __snapshot: {}
      };
      return res.json({ ok: true, data: out, missing: true });
    }

    const UF          = norm(getVal(base, 'UF'));
    const ENTE        = norm(getVal(base, 'ENTE'));
    const UG          = norm(getVal(base, 'UG'));
    const CNPJ_ENTE   = cnpj14(getVal(base, 'CNPJ_ENTE'));
    const CNPJ_UG     = cnpj14(getVal(base, 'CNPJ_UG'));
    const EMAIL_ENTE  = norm(getVal(base, 'EMAIL_ENTE'));
    const EMAIL_UG    = norm(getVal(base, 'EMAIL_UG'));

    const repsAll = await safeGetRows(sReps, 'Reps:getRows');
    const reps = repsAll.filter(r => low(getVal(r,'UF')) === low(UF) && low(getVal(r,'ENTE')) === low(ENTE));
    const repUG = reps.find(r => low(getVal(r,'UG')) === low(UG)) || reps[0] || {};
    const repEnte =
      reps.find(r => ['','ente','adm direta','administração direta','administracao direta'].includes(low(getVal(r,'UG')||''))) ||
      reps.find(r => low(getVal(r,'UG')||'') !== low(UG)) || reps[0] || {};

    const crpAll = await getCRPAllCached(sCrp, skipCache);
    // >>> CRP também compara por CNPJ normalizado
    const crpCandidates = crpAll.filter(r => cnpj14(r.CNPJ_ENTE) === CNPJ_ENTE);
    let crp = {};
    if (crpCandidates.length) {
      crpCandidates.sort((a,b) => (parseDMYorYMD(b.DATA_VALIDADE_DMY) - parseDMYorYMD(a.DATA_VALIDADE_DMY)));
      const top = crpCandidates[0];
      crp.DATA_VALIDADE_DMY = norm(top.DATA_VALIDADE_DMY || '');
      crp.DATA_VALIDADE_ISO = norm(top.DATA_VALIDADE_ISO || '');
      crp.DECISAO_JUDICIAL  = norm(top.DECISAO_JUDICIAL || '');
    }

    const out = {
      UF, ENTE, CNPJ_ENTE, UG, CNPJ_UG,
      EMAIL_ENTE, EMAIL_UG,
      CRP_DATA_VALIDADE_DMY: crp.DATA_VALIDADE_DMY || '',
      CRP_DATA_VALIDADE_ISO: crp.DATA_VALIDADE_ISO || '',
      CRP_DECISAO_JUDICIAL:  crp.DECISAO_JUDICIAL || '',
      ESFERA_SUGERIDA: esferaFromEnte(ENTE),

      __snapshot: {
        UF, ENTE, CNPJ_ENTE, UG, CNPJ_UG,
        NOME_REP_ENTE: norm(getVal(repEnte,'NOME')),
        CPF_REP_ENTE:  digits(getVal(repEnte,'CPF')),
        TEL_REP_ENTE:  norm(getVal(repEnte,'TELEFONE_MOVEL') || getVal(repEnte,'TELEFONE')),
        EMAIL_REP_ENTE:norm(getVal(repEnte,'EMAIL')),
        CARGO_REP_ENTE:norm(getVal(repEnte,'CARGO')),
        NOME_REP_UG:   norm(getVal(repUG,'NOME')),
        CPF_REP_UG:    digits(getVal(repUG,'CPF')),
        TEL_REP_UG:    norm(getVal(repUG,'TELEFONE_MOVEL') || getVal(repUG,'TELEFONE')),
        EMAIL_REP_UG:  norm(getVal(repUG,'EMAIL')),
        CARGO_REP_UG:  norm(getVal(repUG,'CARGO')),
        CRP:           norm(crp.DECISAO_JUDICIAL || ''),
        CRP_VALIDADE:  crp.DATA_VALIDADE_DMY || ''
      }
    };

    if (!skipCache) cacheSet(cacheKey, out);
    return res.json({ ok:true, data: out, missing: false });
  } catch (err) {
    console.error('❌ /api/consulta:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente em instantes.' });
    }
    res.status(500).json({ error:'Falha interna.' });
  }
});

/* ---------- util: atualizar EMAIL_ENTE / EMAIL_UG em CNPJ_ENTE_UG ---------- */
async function upsertEmailsInBase(p){
  const emailEnte = norm(p.EMAIL_ENTE);
  const emailUg   = norm(p.EMAIL_UG);
  if (!emailEnte && !emailUg) return;

  const sCnpj = await getSheetStrict('CNPJ_ENTE_UG');
  await sCnpj.loadHeaderRow();
  const headers = sCnpj.headerValues || [];

  const san = s => (s ?? '')
    .toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');

  const idxOf = name => headers.findIndex(h => san(h) === san(name));

  const col = {
    cnpj_ente: idxOf('CNPJ_ENTE'),
    cnpj_ug:   idxOf('CNPJ_UG'),
    email_ente:idxOf('EMAIL_ENTE'),
    email_ug:  idxOf('EMAIL_UG'),
  };
  if (col.cnpj_ente < 0 && col.cnpj_ug < 0) {
    console.warn('upsertEmailsInBase: não achei colunas CNPJ_ENTE/CNPJ_UG');
    return;
  }

  const endRow = sCnpj.rowCount || 2000;
  const endCol = headers.length || sCnpj.columnCount || 26;

  await safeLoadCells(
    sCnpj,
    { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol },
    'CNPJ:updateEmails:loadCells'
  );

  // >>> normaliza CNPJ para 14 dígitos
  const ce = cnpj14(p.CNPJ_ENTE);
  const cu = cnpj14(p.CNPJ_UG);
  let changed = 0;

  for (let r = 1; r < endRow; r++) {
    let match = false;

    if (col.cnpj_ente >= 0) {
      const v = cnpj14(sCnpj.getCell(r, col.cnpj_ente)?.value || '');
      if (v && ce && v === ce) match = true;
    }
    if (!match && col.cnpj_ug >= 0) {
      const v = cnpj14(sCnpj.getCell(r, col.cnpj_ug)?.value || '');
      if (v && cu && v === cu) match = true;
    }
    if (!match) continue;

    if (emailEnte && col.email_ente >= 0) {
      const cell = sCnpj.getCell(r, col.email_ente);
      const prev = norm(cell.value || '');
      if (prev !== emailEnte) { cell.value = emailEnte; changed++; }
    }
    if (emailUg && col.email_ug >= 0) {
      const cell = sCnpj.getCell(r, col.email_ug);
      const prev = norm(cell.value || '');
      if (prev !== emailUg) { cell.value = emailUg; changed++; }
    }
  }

  if (changed) {
    await withLimiter('CNPJ:saveUpdatedCells', () =>
      withTimeoutAndRetry('CNPJ:saveUpdatedCells', () => sCnpj.saveUpdatedCells())
    );
  }
}

/* ---------- busca rápida por CPF (coluna única + linha alvo) ---------- */
async function findRepByCpfFast(cpfDigits) {
  const sReps = await getSheetStrict('Dados_REP_ENTE_UG');
  await sReps.loadHeaderRow();
  const headers = sReps.headerValues || [];

  const san = s => (s ?? '')
    .toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');

  const idx = {
    UF: headers.findIndex(h => san(h)==='uf'),
    ENTE: headers.findIndex(h => san(h)==='ente'),
    UG: headers.findIndex(h => san(h)==='ug'),
    NOME: headers.findIndex(h => san(h)==='nome'),
    CPF: headers.findIndex(h => san(h)==='cpf'),
    EMAIL: headers.findIndex(h => san(h)==='email'),
    TEL_MOV: headers.findIndex(h => san(h)==='telefone_movel'),
    TEL: headers.findIndex(h => san(h)==='telefone'),
    CARGO: headers.findIndex(h => san(h)==='cargo'),
  };
  if (idx.CPF < 0) throw new Error('Coluna CPF não encontrada em Dados_REP_ENTE_UG');

  const endRow = sReps.rowCount || 2000;

  // 1) carrega só a coluna CPF
  await safeLoadCells(
    sReps,
    { startRowIndex: 1, startColumnIndex: idx.CPF, endRowIndex: endRow, endColumnIndex: idx.CPF + 1 },
    'Reps:scanCPF'
  );

  let rowHit = -1;
  for (let r = 1; r < endRow; r++) {
    const v = digits(sReps.getCell(r, idx.CPF)?.value || '');
    if (v && v === cpfDigits) { rowHit = r; break; }
  }
  if (rowHit < 0) return null;

  // 2) carrega somente a linha encontrada (todas as colunas necessárias)
  const endCol = headers.length || sReps.columnCount || 26;
  await safeLoadCells(
    sReps,
    { startRowIndex: rowHit, startColumnIndex: 0, endRowIndex: rowHit + 1, endColumnIndex: endCol },
    'Reps:readRow'
  );

  const getCellByIdx = (c) => (c >= 0 ? (sReps.getCell(rowHit, c)?.value ?? '') : '');

  return {
    UF: norm(getCellByIdx(idx.UF)),
    ENTE: norm(getCellByIdx(idx.ENTE)),
    UG: norm(getCellByIdx(idx.UG)),
    NOME: norm(getCellByIdx(idx.NOME)),
    CPF: digits(getCellByIdx(idx.CPF)),
    EMAIL: norm(getCellByIdx(idx.EMAIL)),
    TELEFONE: norm(getCellByIdx(idx.TEL_MOV)) || norm(getCellByIdx(idx.TEL)),
    CARGO: norm(getCellByIdx(idx.CARGO)),
  };
}

/* helper: resolve UG quando vier vazia (caso 2.1) */
async function resolveUGIfBlank(UF, ENTE, UG) {
  const ugIn = norm(UG);
  if (ugIn) return ugIn;
  try {
    const sCnpj = await getSheetStrict('CNPJ_ENTE_UG');
    const rows = await safeGetRows(sCnpj, 'CNPJ:resolveUG');
    const match = rows.find(r =>
      low(getVal(r, 'UF')) === low(UF) &&
      low(getVal(r, 'ENTE')) === low(ENTE) &&
      norm(getVal(r, 'UG'))
    );
    return norm(getVal(match || {}, 'UG'));
  } catch {
    return '';
  }
}

/** GET /api/rep-by-cpf?cpf=NNNNNNNNNNN */
app.get('/api/rep-by-cpf', async (req,res)=>{
  try{
    const cpf = digits(req.query.cpf || '');
    if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido.' });

    const cacheKey = `rep:${cpf}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ok: true, data: cached });

    await authSheets();
    const payload = await findRepByCpfFast(cpf);
    if (!payload) return res.status(404).json({ error:'CPF não encontrado.' });

    cacheSet(cacheKey, payload);
    return res.json({ ok:true, data: payload });
  }catch(err){
    console.error('❌ /api/rep-by-cpf:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    res.status(500).json({ error:'Falha interna.' });
  }
});

/* util: upsert representante em Dados_REP_ENTE_UG (para CPF inexistente ou atualização) */
async function upsertRep({ UF, ENTE, UG, NOME, CPF, EMAIL, TELEFONE, CARGO }) {
  const sReps = await getOrCreateSheet('Dados_REP_ENTE_UG', ['UF','ENTE','NOME','CPF','EMAIL','TELEFONE','TELEFONE_MOVEL','CARGO','UG']);
  const rows = await safeGetRows(sReps, 'Reps:getRows');
  const cpf = digits(CPF);
  let row = rows.find(r => digits(getVal(r,'CPF')) === cpf);

  const telBase = norm(TELEFONE);
  const ugFinal = await resolveUGIfBlank(UF, ENTE, UG);

  if (!row) {
    await safeAddRow(sReps, {
      UF: norm(UF), ENTE: norm(ENTE), NOME: norm(NOME),
      CPF: cpf, EMAIL: norm(EMAIL),
      TELEFONE: telBase, TELEFONE_MOVEL: telBase,
      CARGO: norm(CARGO), UG: ugFinal
    }, 'Reps:add');
    return { created: true };
  } else {
    row['UF']   = norm(UF)   || row['UF'];
    row['ENTE'] = norm(ENTE) || row['ENTE'];
    row['UG']   = ugFinal    || row['UG'];
    row['NOME'] = norm(NOME) || row['NOME'];
    row['EMAIL']= norm(EMAIL)|| row['EMAIL'];
    if (telBase) {
      row['TELEFONE']       = telBase;
      row['TELEFONE_MOVEL'] = telBase;
    }
    row['CARGO']= norm(CARGO)|| row['CARGO'];
    await safeSaveRow(row, 'Reps:save');
    return { updated: true };
  }
}

/* util: upsert base do ente/UG quando o CNPJ pesquisado não existir */
async function upsertCNPJBase({ UF, ENTE, UG, CNPJ_ENTE, CNPJ_UG, EMAIL_ENTE, EMAIL_UG }){
  const s = await getOrCreateSheet('CNPJ_ENTE_UG',
    ['UF','ENTE','UG','CNPJ_ENTE','CNPJ_UG','EMAIL_ENTE','EMAIL_UG']
  );
  await s.loadHeaderRow();
  const headers = s.headerValues || [];

  const san = s => (s ?? '')
    .toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');

  const idxOf = name => headers.findIndex(h => san(h) === san(name));

  const col = {
    uf:         idxOf('UF'),
    ente:       idxOf('ENTE'),
    ug:         idxOf('UG'),
    cnpj_ente:  idxOf('CNPJ_ENTE'),
    cnpj_ug:    idxOf('CNPJ_UG'),
    email_ente: idxOf('EMAIL_ENTE'),
    email_ug:   idxOf('EMAIL_UG'),
  };

  // >>> normaliza para comparação e gravação
  const ce = cnpj14(CNPJ_ENTE);
  const cu = cnpj14(CNPJ_UG);

  const endRow = s.rowCount || 2000;
  const endCol = headers.length || s.columnCount || 26;

  await safeLoadCells(
    s,
    { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol },
    'CNPJ:addOrUpdate:loadCells'
  );

  let foundRow = -1;
  for (let r = 1; r < endRow; r++) {
    let hit = false;
    if (col.cnpj_ente >= 0) {
      const v = cnpj14(s.getCell(r, col.cnpj_ente)?.value || '');
      if (v && ce && v === ce) hit = true;
    }
    if (!hit && col.cnpj_ug >= 0) {
      const v = cnpj14(s.getCell(r, col.cnpj_ug)?.value || '');
      if (v && cu && v === cu) hit = true;
    }
    if (hit) { foundRow = r; break; }
  }

  if (foundRow < 0) {
    await safeAddRow(s, {
      UF: norm(UF),
      ENTE: norm(ENTE),
      UG: norm(UG),
      CNPJ_ENTE: ce,
      CNPJ_UG: cu,
      EMAIL_ENTE: norm(EMAIL_ENTE),
      EMAIL_UG: norm(EMAIL_UG)
    }, 'CNPJ:addRow');
    return { created: true };
  }

  let changed = 0;
  const setCellIf = (cIdx, val, transform = x => x) => {
    if (cIdx < 0 || val == null) return;
    const cell = s.getCell(foundRow, cIdx);
    const cur  = norm(cell.value || '');
    const nxt  = norm(transform(val));
    if (cur !== nxt) { cell.value = nxt; changed++; }
  };

  setCellIf(col.uf, UF);
  setCellIf(col.ente, ENTE);
  setCellIf(col.ug, UG);
  setCellIf(col.cnpj_ente, ce);
  setCellIf(col.cnpj_ug, cu);
  setCellIf(col.email_ente, EMAIL_ENTE);
  setCellIf(col.email_ug, EMAIL_UG);

  if (changed) {
    await withLimiter('CNPJ:saveUpdatedCells', () =>
      withTimeoutAndRetry('CNPJ:saveUpdatedCells', () => s.saveUpdatedCells())
    );
    return { updated: true };
  }
  return { updated: false };
}


/* ───────────── Endpoints de escrita ───────────── */

/* ===== util de idempotência ===== */
function makeIdemKeyFromPayload(p) {
  // chaves principais que definem "mesmo termo"
  const keyObj = {
    UF: norm(p.UF),
    ENTE: norm(p.ENTE),
    CNPJ_ENTE: cnpj14(p.CNPJ_ENTE),
    UG: norm(p.UG),
    CNPJ_UG: cnpj14(p.CNPJ_UG),
    CPF_REP_ENTE: digits(p.CPF_REP_ENTE),
    CPF_REP_UG: digits(p.CPF_REP_UG),
    DATA_VENCIMENTO_ULTIMO_CRP: norm(p.DATA_VENCIMENTO_ULTIMO_CRP),
    COMP: norm(p.COMPROMISSO_FIRMADO_ADESAO || ''),
    PROVID: norm(p.PROVIDENCIA_NECESS_ADESAO || ''),
    TS_DIA: String(p.DATA_TERMO_GERADO || ''),   // dia do termo
  };
  const raw = JSON.stringify(keyObj);
  return 'fp_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

async function findTermoByIdemKey(sTermos, idemKey) {
  await sTermos.loadHeaderRow();
  const headers = sTermos.headerValues || [];
  const idx = headers.findIndex(h => String(h).trim().toUpperCase() === 'IDEMP_KEY');
  if (idx < 0) return null;

  const endRow = sTermos.rowCount || 2000;
  await safeLoadCells(
    sTermos,
    { startRowIndex: 1, startColumnIndex: idx, endRowIndex: endRow, endColumnIndex: idx + 1 },
    'Termos:scanIDEMP'
  );

  for (let r = 1; r < endRow; r++) {
    const v = String(sTermos.getCell(r, idx)?.value || '').trim();
    if (v && v === idemKey) return r;
  }
  return null;
}

app.post('/api/upsert-cnpj', async (req,res)=>{
  try{
    await authSheets();
    const r = await upsertCNPJBase(req.body||{});
    res.json({ ok:true, ...r });
  }catch(e){
    console.error('❌ /api/upsert-cnpj:', e);
    const msg = String(e?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    res.status(500).json({ error:'Falha ao gravar base CNPJ_ENTE_UG.' });
  }
});

app.post('/api/upsert-rep', async (req,res)=>{
  try{
    const { UF, ENTE, UG, NOME, CPF, EMAIL, TELEFONE, CARGO } = req.body || {};
    if (digits(CPF).length !== 11) return res.status(400).json({ error:'CPF inválido.' });
    await authSheets();
    const r = await upsertRep({ UF, ENTE, UG, NOME, CPF, EMAIL, TELEFONE, CARGO });
    res.json({ ok:true, ...r });
  }catch(e){
    console.error('❌ /api/upsert-rep:', e);
    const msg = String(e?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    res.status(500).json({ error:'Falha ao gravar representante.' });
  }
});

/** POST /api/gerar-termo  — AGORA IDEMPOTENTE */
app.post('/api/gerar-termo', async (req,res)=>{
  try{
    const p = req.body || {};
    const must = [
      'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
      'NOME_REP_ENTE','CPF_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE',
      'NOME_REP_UG','CPF_REP_UG','CARGO_REP_UG','EMAIL_REP_UG',
      'DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP'
    ];
    for (const k of must) {
      if (!norm(p[k])) return res.status(400).json({ error:`Campo obrigatório ausente: ${k}` });
    }

    await authSheets();

    const sTermos = await getOrCreateSheet('Termos_registrados', [
      'ENTE','UF','CNPJ_ENTE','EMAIL_ENTE',
      'NOME_REP_ENTE','CARGO_REP_ENTE','CPF_REP_ENTE','EMAIL_REP_ENTE',
      'UG','CNPJ_UG','EMAIL_UG',
      'NOME_REP_UG','CARGO_REP_UG','CPF_REP_UG','EMAIL_REP_UG',
      'DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP',
      'CRITERIOS_IRREGULARES',
      'CELEBRACAO_TERMO_PARCELA_DEBITOS',
      'REGULARIZACAO_PENDEN_ADMINISTRATIVA',
      'DEFICIT_ATUARIAL',
      'CRITERIOS_ESTRUT_ESTABELECIDOS',
      'MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS',
      'COMPROMISSO_FIRMADO_ADESAO',
      'PROVIDENCIA_NECESS_ADESAO',
      'CONDICAO_VIGENCIA',
      'MES','DATA_TERMO_GERADO','HORA_TERMO_GERADO','ANO_TERMO_GERADO',
      'IDEMP_KEY' // <<< nova coluna p/ idempotência
    ]);

    // garante coluna IDEMP_KEY (se planilha antiga) — só em memória: se não existir, addRow já cria
    await sTermos.loadHeaderRow();

    // resolve idemKey
    const idemHeader = String(req.headers['x-idempotency-key'] || '').trim();
    const idemBody   = String(p.IDEMP_KEY || '').trim();
    const idemKey    = idemHeader || idemBody || makeIdemKeyFromPayload(p);

    // Se já existir linha com esse IDEMP_KEY, responde OK e sai (idempotência)
    const existingRowIdx = await findTermoByIdemKey(sTermos, idemKey);
    if (existingRowIdx !== null) {
      return res.json({ ok: true, dedup: true });
    }

    const { DATA, HORA, ANO, MES } = nowBR();
    const criterios = Array.isArray(p.CRITERIOS_IRREGULARES)
      ? p.CRITERIOS_IRREGULARES
      : String(p.CRITERIOS_IRREGULARES || '').split(',').map(s=>s.trim()).filter(Boolean);

    await safeAddRow(sTermos, {
      ENTE: norm(p.ENTE), UF: norm(p.UF),
      CNPJ_ENTE: digits(p.CNPJ_ENTE), EMAIL_ENTE: norm(p.EMAIL_ENTE),
      NOME_REP_ENTE: norm(p.NOME_REP_ENTE), CARGO_REP_ENTE: norm(p.CARGO_REP_ENTE),
      CPF_REP_ENTE: digits(p.CPF_REP_ENTE), EMAIL_REP_ENTE: norm(p.EMAIL_REP_ENTE),
      UG: norm(p.UG), CNPJ_UG: digits(p.CNPJ_UG), EMAIL_UG: norm(p.EMAIL_UG),
      NOME_REP_UG: norm(p.NOME_REP_UG), CARGO_REP_UG: norm(p.CARGO_REP_UG),
      CPF_REP_UG: digits(p.CPF_REP_UG), EMAIL_REP_UG: norm(p.EMAIL_REP_UG),
      DATA_VENCIMENTO_ULTIMO_CRP: norm(p.DATA_VENCIMENTO_ULTIMO_CRP),
      TIPO_EMISSAO_ULTIMO_CRP: norm(p.TIPO_EMISSAO_ULTIMO_CRP),
      CRITERIOS_IRREGULARES: criterios.join(', '),
      CELEBRACAO_TERMO_PARCELA_DEBITOS: norm(p.CELEBRACAO_TERMO_PARCELA_DEBITOS),
      REGULARIZACAO_PENDEN_ADMINISTRATIVA: norm(p.REGULARIZACAO_PENDEN_ADMINISTRATIVA),
      DEFICIT_ATUARIAL: norm(p.DEFICIT_ATUARIAL),
      CRITERIOS_ESTRUT_ESTABELECIDOS: norm(p.CRITERIOS_ESTRUT_ESTABELECIDOS),
      MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: norm(p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS),
      COMPROMISSO_FIRMADO_ADESAO: norm(p.COMPROMISSO_FIRMADO_ADESAO),
      PROVIDENCIA_NECESS_ADESAO: norm(p.PROVIDENCIA_NECESS_ADESAO),
      CONDICAO_VIGENCIA: norm(p.CONDICAO_VIGENCIA),
      MES, DATA_TERMO_GERADO: DATA, HORA_TERMO_GERADO: HORA, ANO_TERMO_GERADO: ANO,
      IDEMP_KEY: idemKey
    }, 'Termos:add');

    // 🔐 Garante que os e-mails fiquem na base principal ANTES da resposta
    try {
      await upsertEmailsInBase(p);
    } catch (e) {
      console.warn('upsertEmailsInBase falhou:', e?.message || e);
    }
    res.json({ ok: true });

    setImmediate(async () => {
      try {
        const sLog = await getOrCreateSheet('Reg_alteracao_dados_ente_ug', [
          'UF','ENTE','CAMPOS ALTERADOS','QTD_CAMPOS_ALTERADOS','MES','DATA','HORA'
        ]);

        const snap = p.__snapshot_base || {};
        const userChanged = new Set(Array.isArray(p.__user_changed_fields) ? p.__user_changed_fields : []);
        const allowedForLog = new Set([
          'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
          'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
          'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG',
          'DATA_VENCIMENTO_ULTIMO_CRP'
        ]);

        const compareCols = [...allowedForLog];
        const changed = [];
        if (Object.keys(snap).length && userChanged.size) {
          for (const col of compareCols) {
            if (!userChanged.has(col)) continue;
            const a = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL')) ? digits(snap[col] || '') : norm(snap[col] || '');
            const b = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL')) ? digits(p[col] || '')   : norm(p[col] || '');
            if (low(a) !== low(b)) changed.push(col);
          }
        }

        if (changed.length) {
          const t = nowBR();
          await safeAddRow(sLog, {
            UF: norm(p.UF), ENTE: norm(p.ENTE),
            'CAMPOS ALTERADOS': changed.join(', '),
            'QTD_CAMPOS_ALTERADOS': changed.length,
            MES: t.MES, DATA: t.DATA, HORA: t.HORA
          }, 'Log:add');
        }

      } catch (bgErr) {
        console.warn('gerar-termo (background):', bgErr?.message || bgErr);
      }
    });

  } catch (err) {
    console.error('❌ /api/gerar-termo:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    res.status(500).json({ error:'Falha ao registrar o termo.' });
  }
});


/* ========= PDF (Puppeteer) ========= */

/* Limiter dedicado para PDF (evita picos de memória) */
const PDF_CONCURRENCY = Number(process.env.PDF_CONCURRENCY || 1);
const _pdfQ = [];
let _pdfActive = 0;
function _pdfRunNext() {
  if (_pdfActive >= PDF_CONCURRENCY) return;
  const it = _pdfQ.shift();
  if (!it) return;
  _pdfActive++;
  (async () => {
    try { it.resolve(await it.fn()); }
    catch (e) { it.reject(e); }
    finally { _pdfActive--; _pdfRunNext(); }
  })();
}
function withPdfLimiter(fn) {
  return new Promise((resolve, reject) => {
    _pdfQ.push({ fn, resolve, reject });
    _pdfRunNext();
  });
}

const _svgCache = {};
function inlineSvg(relPath) {
  try {
    const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/,''));
    if (_svgCache[abs]) return _svgCache[abs];
    const raw = fs.readFileSync(abs, 'utf8');
    const cleaned = raw
      .replace(/<\?xml[^>]*>/g, '')
      .replace(/<!DOCTYPE[^>]*>/g, '')
      .replace(/\r?\n|\t/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
    _svgCache[abs] = cleaned;
    return cleaned;
  } catch (e) {
    console.warn('⚠️  Falha ao ler SVG:', relPath, e.message);
    return '';
  }
}

/* Fonte local opcional (para evitar bloqueios CORP/CORS em headless) */
function inlineFont(relPath) {
  try {
    const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/, ''));
    const buf = fs.readFileSync(abs);
    const b64 = buf.toString('base64');
    const ext = path.extname(abs).toLowerCase();

    const mime = ext === '.woff2' ? 'font/woff2'
              : ext === '.woff'  ? 'font/woff'
              : ext === '.ttf'   ? 'font/ttf'
              : 'application/octet-stream';

    const fmt  = ext === '.woff2' ? 'woff2'
              : ext === '.woff'  ? 'woff'
              : 'truetype';

    return `url(data:${mime};base64,${b64}) format('${fmt}')`;
  } catch (e) {
    return null;
  }
}

app.post('/api/termo-pdf', async (req, res) => {
  await withPdfLimiter(async () => {
    // Contexto único (sem incognito) + retry defensivo para TargetCloseError
    let page;
    let browser;
    let triedRestart = false;
    try {
      const p = req.body || {};

      const compAgg = String(p.COMPROMISSO_FIRMADO_ADESAO || '');
      const compCodes = ['5.1','5.2','5.3','5.4','5.5','5.6']
        .filter(code => new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`).test(compAgg));

      const qs = new URLSearchParams({
        uf: p.UF || '',
        ente: p.ENTE || '',
        cnpj_ente: p.CNPJ_ENTE || '',
        email_ente: p.EMAIL_ENTE || '',
        ug: p.UG || '',
        cnpj_ug: p.CNPJ_UG || '',
        email_ug: p.EMAIL_UG || '',
        esfera: p.ESFERA || '',
        nome_rep_ente: p.NOME_REP_ENTE || '',
        cpf_rep_ente: p.CPF_REP_ENTE || '',
        cargo_rep_ente: p.CARGO_REP_ENTE || '',
        email_rep_ente: p.EMAIL_REP_ENTE || '',
        nome_rep_ug: p.NOME_REP_UG || '',
        cpf_rep_ug: p.CPF_REP_UG || '',
        cargo_rep_ug: p.CARGO_REP_UG || '',
        email_rep_ug: p.EMAIL_REP_UG || '',
        venc_ult_crp: p.DATA_VENCIMENTO_ULTIMO_CRP || '',
        tipo_emissao_crp: p.TIPO_EMISSAO_ULTIMO_CRP || '',
        celebracao: p.CELEBRACAO_TERMO_PARCELA_DEBITOS || '',
        regularizacao: p.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '',
        deficit: p.DEFICIT_ATUARIAL || '',
        criterios_estrut: p.CRITERIOS_ESTRUT_ESTABELECIDOS || '',
        manutencao_normas: p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS || '',
        compromisso: p.COMPROMISSO_FIRMADO_ADESAO || '',
        providencias: p.PROVIDENCIA_NECESS_ADESAO || '',
        condicao_vigencia: p.CONDICAO_VIGENCIA || '',
        data_termo: p.DATA_TERMO_GERADO || '',
        auto: '1'
      });

      (Array.isArray(p.CRITERIOS_IRREGULARES) ? p.CRITERIOS_IRREGULARES : [])
        .forEach((c, i) => qs.append(`criterio${i+1}`, String(c || '')));
      compCodes.forEach(code => qs.append('comp', code));

      // PUBLIC_URL robusto por request (pega host e protocolo corretos atrás do proxy)
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
      const host  = req.get('host');
      const FALLBACK_BASE = `${proto}://${host}`;
      const PUBLIC_URL = (process.env.PUBLIC_URL || FALLBACK_BASE).replace(/\/+$/, '');
      const url = `${PUBLIC_URL}/termo.html?${qs.toString()}`;

      // ==== abre o Chrome e cria a página com retry uma vez se necessário
      try {
        browser = await getBrowser();
        page = await browser.newPage();
      } catch (e) {
        const msg = String(e?.message || '');
        if (!triedRestart && /Target closed|Browser is closed|WebSocket is not open|TargetCloseError/i.test(msg)) {
          triedRestart = true;
          try { await browser?.close().catch(()=>{}); } catch(_){}
          _browserPromise = null;
          browser = await getBrowser();
          page = await browser.newPage();
        } else {
          throw e;
        }
      }

      await page.setCacheEnabled(false);

      await page.setRequestInterception(true);
      page.on('request', (reqObj) => {
        const u = reqObj.url();
        const t = reqObj.resourceType();

        if (/fonts\.cdnfonts\.com|fonts\.gstatic\.com/i.test(u)) {
          if (t === 'stylesheet') {
            return reqObj.respond({ status: 200, contentType: 'text/css', body: '/* font css blocked in pdf */' });
          }
          return reqObj.abort();
        }
        if (/googletagmanager|google-analytics|doubleclick|hotjar|clarity|sentry|facebook|meta\./i.test(u)) {
          return reqObj.abort();
        }
        return reqObj.continue();
      });

      page.setDefaultNavigationTimeout(90_000);
      page.setDefaultTimeout(90_000);
      page.on('console', m => console.log('🖥', m.type().toUpperCase(), m.text()));
      page.on('requestfailed', r => console.log('⚠️ FAIL', r.url(), r.failure()?.errorText));

      await page.emulateMediaType('screen');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForSelector('#pdf-root', { timeout: 20_000 }).catch(()=>{});

      function findFont(candidates){
        for (const rel of candidates){
          const abs = path.join(__dirname, '../frontend', rel.replace(/^\/+/, ''));
          if (fs.existsSync(abs)) return inlineFont(rel);
        }
        return null;
      }

      const rawline400 = findFont([
        'fonts/rawline-regular.woff2','fonts/rawline-regular.woff','fonts/rawline-regular.ttf',
        'fonts/rawline-400.woff2','fonts/rawline-400.woff','fonts/rawline-400.ttf'
      ]);

      const rawline700 = findFont([
        'fonts/rawline-bold.woff2','fonts/rawline-bold.woff','fonts/rawline-bold.ttf',
        'fonts/rawline-700.woff2','fonts/rawline-700.woff','fonts/rawline-700.ttf'
      ]);

      console.log('[PDF] Rawline 400:', !!rawline400 ? 'OK' : 'NÃO ENCONTRADO');
      console.log('[PDF] Rawline 700:', !!rawline700 ? 'OK' : 'NÃO ENCONTRADO');

      let fontCSS = '';
      if (rawline400) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:400;src:${rawline400};font-display:swap;}`;
      if (rawline700) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:700;src:${rawline700};font-display:swap;}`;
      fontCSS += `body{font-family:'Rawline', Inter, Arial, sans-serif;}`;

      await page.addStyleTag({
        content: `
          ${fontCSS}
          html, body, #pdf-root { background:#ffffff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .page-head .logos-wrap { display: none !important; }
          .term-wrap { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
          .term-title { margin-top: 2mm !important; }
        `
      });

      await page.evaluate(() => {
        document.body.classList.add('pdf-export');
        const root = document.getElementById('pdf-root');
        if (root) root.classList.add('pdf-export');
      });

      const svgSec = inlineSvg('imagens/logo-secretaria-complementar.svg');
      const svgMps = inlineSvg('imagens/logo-termo-drpps.svg');

      const headerTemplate = `
        <style>
          .pdf-header {
            font-family: Inter, Arial, sans-serif;
            width: 100%;
            padding: 6mm 12mm 4mm;
          }
          .pdf-header .logos { display:flex; align-items:center; justify-content:center; gap:16mm; }
          .pdf-header .logo-sec svg { height: 19mm; width:auto; }
          .pdf-header .logo-mps svg { height: 20mm; width:auto; }
          .pdf-header .rule { margin:4mm 0 0; height:0; border-bottom:1.3px solid #d7dee8; width:100%; }
          .date, .title, .url, .pageNumber, .totalPages { display:none; }
        </style>
        <div class="pdf-header">
          <div class="logos">
            <div class="logo-sec">${svgSec}</div>
            <div class="logo-mps">${svgMps}</div>
          </div>
          <div class="rule"></div>
        </div>
      `;

      const footerTemplate = `<div></div>`;

      const pdf = await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: { top: '38mm', right: '0mm', bottom: '12mm', left: '0mm' }
      });

      await page.close();

      const filenameSafe = (p.ENTE || 'termo-adesao')
        .normalize('NFD').replace(/\p{Diacritic}/gu,'')
        .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
        .toLowerCase();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="termo-${filenameSafe}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(pdf);
    } catch (e) {
      console.error('❌ /api/termo-pdf:', e);
      try { if (page) await page.close(); } catch(_) {}
      res.status(500).json({ error: 'Falha ao gerar PDF' });
    }
  });
});

/* ───────────── Start ───────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));

/* ───────────── Captura global de erros (defensivo) ───────────── */
process.on('uncaughtException', (err) => {
  console.error('⛑️  uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⛑️  unhandledRejection:', reason);
});

/* ───────────── Helpers locais ───────────── */
function getVal(row, ...candidates) {
  const keys = Object.keys(row);
  const normKey = s => (s ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/__\d+$/,'')
    .replace(/^_+|_+$/g, '');

  const map = new Map(keys.map(k => [normKey(k), k]));

  for (const cand of candidates) {
    const nk = normKey(cand);
    const real = map.get(nk);
    if (real) return row[real];
  }
  return undefined;
}
