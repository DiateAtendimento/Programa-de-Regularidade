// server.js — API RPPS (multi-etapas) c/ idempotência em /api/gerar-termo
// Hardened: CORS allowlist obrigatório, API key em prod, sanitização p/ Sheets,
// Puppeteer same-origin only, Helmet extra (Referrer, COOP, HSTS), rate-limit fallback,
// Joi validation e trust proxy ajustável.

'use strict';

require('dotenv').config();
const Joi = require('joi');
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
const url = require('url');

const app = express();

/* ───────────── Níveis de log / debug ───────────── */
const LOG_LEVEL = (process.env.LOG_LEVEL || 'warn').toLowerCase();
const DEBUG_CORS = process.env.DEBUG_CORS === '1';

/* ───────────── Conexões/robustez ───────────── */
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

const CACHE_TTL_MS       = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const CACHE_TTL_CRP_MS   = Number(process.env.CACHE_TTL_CRP_MS || 2 * 60 * 1000);

const SHEETS_CONCURRENCY  = Number(process.env.SHEETS_CONCURRENCY || 1);
const SHEETS_TIMEOUT_MS   = Number(process.env.SHEETS_TIMEOUT_MS || 60_000);
const SHEETS_RETRIES      = Number(process.env.SHEETS_RETRIES || 2);

/* ───────────── Segurança ───────────── */
// trust proxy ajustável (útil p/ Render/NGINX). Exemplos aceitos: "1", "true", "loopback", "127.0.0.1"
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY ?? '1').trim().toLowerCase();
let TRUST_PROXY;
if (TRUST_PROXY_RAW === '0' || TRUST_PROXY_RAW === 'false' || TRUST_PROXY_RAW === 'off') TRUST_PROXY = false;
else if (TRUST_PROXY_RAW === 'true' || TRUST_PROXY_RAW === '1') TRUST_PROXY = 1;
else TRUST_PROXY = TRUST_PROXY_RAW; // passa string como 'loopback' ou IP/CIDR
app.set('trust proxy', TRUST_PROXY);

app.disable('x-powered-by');

/* util env list */
const splitList = (s = '') =>
  s.split(/[\s,]+/).map(v => v.trim().replace(/\/+$/, '')).filter(Boolean);

/* ───────────── CORS (allowlist obrigatória) ───────────── */
const ALLOW_LIST = new Set(
  splitList(process.env.CORS_ORIGIN_LIST || '')
    .map(u => u.replace(/\/+$/, '').toLowerCase())
);
function isAllowedOrigin(origin) {
  if (!origin) return false; // sem origin ⇒ nega (evita burlas de CORS)
  const o = origin.replace(/\/+$/, '').toLowerCase();
  if (ALLOW_LIST.size === 0) return false; // allowlist obrigatória
  return ALLOW_LIST.has(o);
}
const corsOptionsDelegate = (req, cb) => {
  const originIn = (req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
  const ok = isAllowedOrigin(originIn);

  if (req.path.startsWith('/api/') && DEBUG_CORS) {
    console.log(`CORS ▶ ${originIn || '(sem origin)'} → ${ok ? 'ALLOW' : 'DENY'} | ALLOW_LIST=[${[...ALLOW_LIST].join(', ')}]`);
  }

  const reqHdrs = String(req.headers['access-control-request-headers'] || '')
    .replace(/[^\w\-_, ]/g, '');

  cb(null, {
    origin: ok ? originIn : false,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: reqHdrs || 'Content-Type,Authorization,Cache-Control,X-Idempotency-Key,X-API-Key',
    exposedHeaders: ['Content-Disposition'],
    credentials: false,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  });
};
app.use(cors(corsOptionsDelegate));
app.options(/.*/, cors(corsOptionsDelegate));
// Opcional: deixa explícito o Vary de CORS
app.use((req, res, next) => {
  res.vary('Origin');
  res.vary('Access-Control-Request-Headers');
  res.vary('Access-Control-Request-Method');
  next();
});


/* ───────────── Helmet + middlewares ───────────── */
const connectExtra = splitList(process.env.CORS_ORIGIN_LIST || '');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // servimos estáticos
  crossOriginEmbedderPolicy: false,                      // evitamos COEP p/ PDF
}));
app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    styleSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.cdnfonts.com", "'unsafe-inline'"],
    fontSrc:  ["'self'", "https://fonts.gstatic.com", "https://fonts.cdnfonts.com", "data:"],
    imgSrc:   ["'self'", "data:", "blob:"],
    connectSrc: ["'self'", ...connectExtra],
    objectSrc: ["'none'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
}));
// Referrer-Policy + COOP
app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));
app.use(helmet.crossOriginOpenerPolicy({ policy: 'same-origin' }));

// HSTS somente quando Express considerar a conexão segura (respeita trust proxy)
const hstsMw = (req, res, next) => {
  if (req.secure) {
    return helmet.hsts({ maxAge: 15552000, includeSubDomains: true, preload: true })(req, res, next);
  }
  return next();
};

app.use(hstsMw);

// Rate limits por rota + fallback
const rlCommon   = rateLimit({ windowMs: 15*60*1000, max: 400, standardHeaders: true, legacyHeaders: false });
const rlWrite    = rateLimit({ windowMs: 15*60*1000, max: 120, standardHeaders: true, legacyHeaders: false });
const rlPdf      = rateLimit({ windowMs: 15*60*1000, max: 20,  standardHeaders: true, legacyHeaders: false });
const rlFallback = rateLimit({ windowMs: 15*60*1000, max: 600, standardHeaders: true, legacyHeaders: false });
const skipPaths = new Set(['/health','/healthz','/warmup']);
app.use('/api', (req, res, next) => skipPaths.has((req.path||'').toLowerCase()) ? next() : rlFallback(req,res,next)); // fallback

// específicos
app.use('/api/consulta', rlCommon);
app.use('/api/rep-by-cpf', rlCommon);
app.use('/api/upsert-cnpj', rlWrite);
app.use('/api/upsert-rep', rlWrite);
app.use('/api/gerar-termo', rlWrite);
app.use('/api/termo-pdf', rlPdf);
app.use('/api/gescon/termo-enc', rlCommon);
app.use('/api/termos-registrados', rlCommon);
app.use('/api/solic-crp-pdf', rlPdf);
app.use('/api/gerar-solic-crp', rlWrite);
app.use('/api/termo-solic-crp-pdf', rlPdf);




// Política de API key: exige em produção ou se REQUIRE_API_KEY=1
const REQUIRE_API_KEY = (process.env.REQUIRE_API_KEY ?? (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1';

// ❗ Bloqueia boot se exigir API key e ela não estiver configurada
if (REQUIRE_API_KEY && !process.env.API_KEY) {
  console.error('❌ API_KEY obrigatória quando REQUIRE_API_KEY=1');
  process.exit(1);
}

app.use('/api', (req, res, next) => {
  const p = (req.path || '').toLowerCase();
  if (req.method === 'OPTIONS' || p === '/health' || p === '/healthz' || p === '/warmup') return next();
  return REQUIRE_API_KEY ? requireKey(req, res, next) : next();
});

app.use(hpp());
app.use(express.json({ limit: '300kb' }));

/* ───────────── Cache-Control das rotas de API ───────────── */
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

/* ───────────── Static ───────────── */
const FRONTEND_DIR = path.join(__dirname, '../frontend');
app.use('/', express.static(FRONTEND_DIR));

function trySendStatic(res, relPath) {
  const abs = path.join(FRONTEND_DIR, relPath);
  if (fs.existsSync(abs)) return res.sendFile(abs);
  return null;
}
app.get(['/favicon.ico','/favicon.png'], (req, res) => {
  if (trySendStatic(res, 'favicon.ico')) return;
  if (trySendStatic(res, 'favicon.png')) return;
  res.status(204).end();
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
const cnpj14 = v => digits(v).padStart(14, '0').slice(-14);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm(v));

/* ───────────── Segurança extra: compare seguro, escape HTML e planilha-safe ───────────── */
function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a) || '', 'utf8');
    const B = Buffer.from(String(b) || '', 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

/** Protege endpoints: só ativa se API_KEY existir ou se REQUIRE_API_KEY=true */
function requireKey(req, res, next) {
  if (!REQUIRE_API_KEY) return next();

  const must = process.env.API_KEY;
  const got = req.headers['x-api-key'];

  // Não deixe passar silenciosamente em caso de má config
  if (typeof must !== 'string' || must.length < 8) {
    return res.status(500).json({ error: 'API key não configurada no servidor.' });
  }
  if (typeof got !== 'string' || must.length !== got.length) {
    return res.status(401).json({ error: 'API key ausente ou inválida.' });
  }

  try {
    if (crypto.timingSafeEqual(Buffer.from(must, 'utf8'), Buffer.from(got, 'utf8'))) {
      return next();
    }
  } catch (_) {
    // fallthrough
  }
  return res.status(401).json({ error: 'API key ausente ou inválida.' });
}


/** Escape rápido para HTML (se quiser usar no termo.html) */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function sanitizeForSheet(v) {
  const s = String(v ?? '');
  if (!s) return '';
  if (s.startsWith("'")) return s;

  // protege contra CSV/Planilha injection
  if (/^[=\+\-@]/.test(s) || /^\t/.test(s)) return `'${s}`;

  // ⚠️ NOVO: para números puros (ex.: CPF/CNPJ) preserva zeros à esquerda
  // regra: só dígitos e comprimento >= 11 (CPF) — cobre CNPJ (14) também
  if (/^\d{11,}$/.test(s)) return `'${s}`;

  return s;
}


/** Aplica sanitize em objeto plano (somente campos string) */
function sheetSanObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = (typeof v === 'string') ? sanitizeForSheet(v) : v;
  }
  return out;
}
const sanitizeIfStr = v => (typeof v === 'string' ? sanitizeForSheet(v) : v);

/* Data/Hora BR */
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
  const minCols = Math.max(Array.isArray(headerValues) ? headerValues.length : 0, 26);

  s = await doc.addSheet({
    title,
    headerValues,
    gridProperties: { rowCount: 1000, columnCount: minCols } // 👈 já nasce com espaço
  });
  return s;
}

async function ensureSheetHasColumns(sheet, requiredHeaders = []) {
  await sheet.loadHeaderRow();
  const current = sheet.headerValues || [];
  const have = new Set(current.map(s => String(s ?? '').trim().toUpperCase()));
  const missing = requiredHeaders.filter(h => !have.has(String(h).toUpperCase()));
  if (!missing.length) return false;

  const next = [...current, ...missing];

  // 🔧 garante colunas suficientes para TODOS os cabeçalhos
  await ensureMinColumns(sheet, next.length);

  await withLimiter(`${sheet.title}:setHeaderRow`, () =>
    withTimeoutAndRetry(`${sheet.title}:setHeaderRow`, () => sheet.setHeaderRow(next))
  );
  return true;
}


// Garante que a planilha tenha ao menos N colunas (evita "Sheet is not large enough...")
async function ensureMinColumns(sheet, minCols) {
  const currentCols = Number(sheet.columnCount || 0);
  if (currentCols >= minCols) return false;

  // Mantém a quantidade de linhas atual (ou 1000, se ausente)
  const nextRows = Number(sheet.rowCount || 1000);

  await withLimiter(`${sheet.title}:resize`, () =>
    withTimeoutAndRetry(`${sheet.title}:resize`, () =>
      sheet.resize({ rowCount: nextRows, columnCount: minCols })
    )
  );
  return true;
}


/* ===== Concorrência + Timeout/Retry (Sheets) ===== */
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
      const backoff = Math.min(5000, 800 * Math.pow(2, attempt - 1));
      await sleep(backoff);
    }
  }
}
async function getRowsSafe(sheet) {
  try { return await sheet.getRows(); }
  catch (e) {
    if (String(e?.message || '').toLowerCase().includes('duplicate header')) {
      return await getRowsViaCells(sheet);
    }
    throw e;
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
  // SANITIZA ANTES DE GRAVAR
  return withLimiter(`${label || sheet.title}:addRow`, () =>
    withTimeoutAndRetry(`${label || sheet.title}:addRow`, () => sheet.addRow(sheetSanObject(data)))
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

/* Helpers p/ headers duplicados */
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
    const base = sanitize(h); if (!base) return '';
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] === 1 ? base : `${base}__${seen[base]}`;
  });
  const cols = headersUnique.length || sheet.columnCount || 26;
  const endRow = sheet.rowCount || 2000;
  await safeLoadCells(sheet, { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: cols }, 'viaCells:load');
  const rows = [];
  for (let r = 1; r < endRow; r++) {
    let empty = true; const obj = {};
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
/* Datas */
function parseDMYorYMD(s) {
  const v = norm(s);
  if (!v) return new Date(0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v+'T00:00:00');
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  const d = new Date(v);
  return isNaN(d) ? new Date(0) : d;
}
// helper simples para ler célula (valor formatado > valor bruto) como string
function cellStr(sheet, rowIdx, colIdx) {
  if (colIdx < 0) return '';
  const cell = sheet.getCell(rowIdx, colIdx);
  const v = (cell?.formattedValue ?? cell?.value ?? '');
  return String(v).trim();
}

// ── coloque após parseDMYorYMD / format helpers ──
function normalizeSheetDateAny(cell) {
  // tenta formattedValue primeiro (caso "dd/mm/aaaa")
  const fv = cell?.formattedValue;
  if (fv && /^\d{2}\/\d{2}\/\d{4}$/.test(String(fv))) {
    const d = parseDMYorYMD(fv);
    return { iso: formatDateISO(d), dmy: formatDateDMY(d), raw: fv };
  }
  // Date nativo
  if (cell?.value instanceof Date) {
    const d = cell.value;
    return { iso: formatDateISO(d), dmy: formatDateDMY(d), raw: String(fv || d.toISOString()) };
  }
  // Número (serial Sheets/Excel)
  if (typeof cell?.value === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + cell.value * 86400000);
    return { iso: formatDateISO(d), dmy: formatDateDMY(d), raw: String(cell.value) };
  }
  // String livre
  const s = String(cell?.value || '').trim();
  if (s) {
    const d = parseDMYorYMD(s);
    return { iso: formatDateISO(d), dmy: formatDateDMY(d), raw: s };
  }
  return { iso: '', dmy: '', raw: '' };
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



/* === CRP FAST LOOKUP === */
async function findCRPByCnpjFast(sheet, cnpjDigits) {
  const colCNPJ = 1, colVal = 5, colDec = 6; // 0-based: B, F, G
  const endRow = sheet.rowCount || 2000;

  await safeLoadCells(
    sheet,
    { startRowIndex: 1, startColumnIndex: colCNPJ, endRowIndex: endRow, endColumnIndex: colCNPJ + 1 },
    'CRP:scanCNPJ'
  );

  const hits = [];
  for (let r = 1; r < endRow; r++) {
    const v = String(sheet.getCell(r, colCNPJ)?.value ?? '').replace(/\D+/g, '');
    if (v && v === cnpjDigits) hits.push(r);
  }
  if (!hits.length) return null;

  let best = null, bestTs = 0;
  for (const r of hits) {
    await safeLoadCells(
      sheet,
      { startRowIndex: r, startColumnIndex: colVal, endRowIndex: r + 1, endColumnIndex: colDec + 1 },
      'CRP:readRowMini'
    );

    const valCell = sheet.getCell(r, colVal);
    const decCell = sheet.getCell(r, colDec);

    let d;
    const fv = valCell?.formattedValue;
    if (fv && /^\d{2}\/\d{2}\/\d{4}$/.test(String(fv))) {
      const [dd, mm, yy] = String(fv).split('/');
      d = new Date(`${yy}-${mm}-${dd}T00:00:00`);
    } else if (valCell?.value instanceof Date) {
      d = valCell.value;
    } else if (typeof valCell?.value === 'number') {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      d = new Date(epoch.getTime() + valCell.value * 86400000);
    } else {
      d = parseDMYorYMD(valCell?.value || '');
    }

    const ts = d?.getTime?.() || 0;
    const decisao = norm(decCell?.formattedValue ?? decCell?.value ?? '');

    const rec = {
      DATA_VALIDADE_DMY: formatDateDMY(d),
      DATA_VALIDADE_ISO: formatDateISO(d),
      DECISAO_JUDICIAL: decisao
    };

    if (ts > bestTs) { bestTs = ts; best = rec; }
  }
  return best;
}

/* ─────────────── PUPPETEER (robust + same-origin only) ─────────────── */
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
    const localPuppeteerDir = path.resolve(__dirname, '.puppeteer');
    const altBackendDir = path.resolve(__dirname, '../backend/.puppeteer');
    const resolved =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      findChromeIn(localPuppeteerDir) ||
      findChromeIn(altBackendDir);

    const byApi = (() => { try { return require('puppeteer').executablePath(); } catch { return null; } })();
    const chromePath = resolved || byApi;
    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new Error(`Chrome não encontrado. Defina PUPPETEER_EXECUTABLE_PATH ou garanta o download em ".puppeteer" (postinstall).`);
    }

    _browserPromise = puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--font-render-hinting=none'],
      timeout: 60_000
    }).then(browser => {
      browser.on('disconnected', () => {
        if ((process.env.LOG_LEVEL || '').toLowerCase() !== 'silent') {
          console.warn('⚠️  Puppeteer desconectado — resetando instância.');
        }
        _browserPromise = null;
      });
      return browser;
    });
  }
  return _browserPromise;
}

/* ─────────────── ROTAS BÁSICAS ─────────────── */
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

// garante que a aba tenha header; cria e redimensiona colunas se necessário
async function ensureHeaderRow(sheet, headerValues = []) {
  try {
    await sheet.loadHeaderRow();
    const hasHeader = Array.isArray(sheet.headerValues) && sheet.headerValues.length > 0;

    // Se a aba não tem header e recebemos um, garanta colunas suficientes
    if (!hasHeader && headerValues.length) {
      await ensureMinColumns(sheet, headerValues.length);
      await withLimiter(`${sheet.title}:setHeaderRow`, () =>
        withTimeoutAndRetry(`${sheet.title}:setHeaderRow`, () => sheet.setHeaderRow(headerValues))
      );
    }
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    // caso clássico: "no values in the header row"
    if (msg.includes('no values in the header row') && headerValues.length) {
      await ensureMinColumns(sheet, headerValues.length);
      await withLimiter(`${sheet.title}:setHeaderRow`, () =>
        withTimeoutAndRetry(`${sheet.title}:setHeaderRow`, () => sheet.setHeaderRow(headerValues))
      );
    } else {
      throw e;
    }
  }
}


app.get('/api/health', (_req,res)=> res.json({ ok:true }));
app.get('/api/healthz', (_req,res)=> res.json({ ok:true, uptime: process.uptime(), ts: Date.now() }));
app.get('/api/warmup', async (_req, res) => {
  try {
    await authSheets();
    await getBrowser();
    res.json({ ok: true, warmed: true, ts: Date.now() });
  } catch {
    res.status(500).json({ ok: false, error: 'warmup failed' });
  }
});
/** GET /api/consulta?cnpj=NNNNNNNNNNNNNN[&nocache=1] */
app.get('/api/consulta', async (req, res) => {
  try {
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

    // FAST: busca a linha do CNPJ sem ler a planilha inteira
    const base = await (async () => {
      await sCnpj.loadHeaderRow();
      const headers = sCnpj.headerValues || [];
      const san = s => (s ?? '').toString().trim().toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'_')
        .replace(/_+/g,'_').replace(/^_+|_+$/g,'');
      const idx = {
        cnpj_ente: headers.findIndex(h => san(h) === 'cnpj_ente'),
        cnpj_ug:   headers.findIndex(h => san(h) === 'cnpj_ug'),
      };
      if (idx.cnpj_ente < 0 && idx.cnpj_ug < 0) return null;

      const endRow = sCnpj.rowCount || 2000;
      // ENT(E)
      if (idx.cnpj_ente >= 0) {
        await safeLoadCells(sCnpj, { startRowIndex: 1, startColumnIndex: idx.cnpj_ente, endRowIndex: endRow, endColumnIndex: idx.cnpj_ente + 1 }, 'CNPJ:scan_ENTE');
        for (let r = 1; r < endRow; r++) {
          const v = String(sCnpj.getCell(r, idx.cnpj_ente)?.value ?? '').replace(/\D+/g,'');
          if (v && v === cnpj) {
            const endCol = headers.length || sCnpj.columnCount || 26;
            await safeLoadCells(sCnpj, { startRowIndex: r, startColumnIndex: 0, endRowIndex: r + 1, endColumnIndex: endCol }, 'CNPJ:readRow_ENTE');
            const rowObj = {};
            for (let c = 0; c < endCol; c++) { rowObj[headers[c] || `COL_${c+1}`] = String(sCnpj.getCell(r, c)?.value ?? ''); }
            return rowObj;
          }
        }
      }
      // UG
      if (idx.cnpj_ug >= 0) {
        await safeLoadCells(sCnpj, { startRowIndex: 1, startColumnIndex: idx.cnpj_ug, endRowIndex: endRow, endColumnIndex: idx.cnpj_ug + 1 }, 'CNPJ:scan_UG');
        for (let r = 1; r < endRow; r++) {
          const v = String(sCnpj.getCell(r, idx.cnpj_ug)?.value ?? '').replace(/\D+/g,'');
          if (v && v === cnpj) {
            const endCol = headers.length || sCnpj.columnCount || 26;
            await safeLoadCells(sCnpj, { startRowIndex: r, startColumnIndex: 0, endRowIndex: r + 1, endColumnIndex: endCol }, 'CNPJ:readRow_UG');
            const rowObj = {};
            for (let c = 0; c < endCol; c++) { rowObj[headers[c] || `COL_${c+1}`] = String(sCnpj.getCell(r, c)?.value ?? ''); }
            return rowObj;
          }
        }
      }
      return null;
    })();

    if (!base) {
      const out = {
        UF: '', ENTE: '',
        CNPJ_ENTE: cnpj, UG: '', CNPJ_UG: '',
        EMAIL_ENTE: '', EMAIL_UG: '',
        CRP_DATA_VALIDADE_DMY: '', CRP_DATA_VALIDADE_ISO: '',
        CRP_DECISAO_JUDICIAL: '',
        ESFERA_SUGERIDA: '',
        __snapshot: {}
      };
      return res.json({ ok: true, data: out, missing: true });
    }

    // --- Header sanitizer p/ chaves de planilha ---
    const _sanKey = (s) => (s ?? '')
      .toString()
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    // --- Lê um campo de row/obj do google-spreadsheet (robusto) ---
    function getVal(rowOrObj, key) {
      if (!rowOrObj || !key) return '';

      // 1) acesso direto
      if (Object.prototype.hasOwnProperty.call(rowOrObj, key)) {
        return rowOrObj[key] ?? '';
      }

      // 2) Row.get('Cabeçalho')
      if (typeof rowOrObj.get === 'function') {
        try {
          const v = rowOrObj.get(key);
          if (v != null) return v;
        } catch (_) {}
      }

      // 3) match por chave normalizada
      const want = _sanKey(key);
      for (const [k, v] of Object.entries(rowOrObj)) {
        if (_sanKey(k) === want) return v ?? '';
      }

      // 4) fallback: _rawData + headerValues
      const raw = rowOrObj._rawData;
      const headers = rowOrObj._sheet?.headerValues;
      if (Array.isArray(raw) && Array.isArray(headers) && headers.length === raw.length) {
        const idx = headers.findIndex(h => _sanKey(h) === want);
        if (idx >= 0) return raw[idx] ?? '';
      }
      return '';
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

    let crp = {};
    if (CNPJ_ENTE) {
      const ck = `crp:${CNPJ_ENTE}`;
      if (!skipCache) crp = cacheGet(ck) || {};
      if (!crp || (!crp.DATA_VALIDADE_DMY && !crp.DECISAO_JUDICIAL)) {
        crp = await findCRPByCnpjFast(sCrp, CNPJ_ENTE) || {};
        if (!skipCache && (crp.DATA_VALIDADE_DMY || crp.DECISAO_JUDICIAL)) {
          cacheSet(ck, crp, CACHE_TTL_CRP_MS);
        }
      }
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
  const emailEnteIn = norm(p.EMAIL_ENTE);
  const emailUgIn   = norm(p.EMAIL_UG);
  const emailRepEnteIn = norm(p.EMAIL_REP_ENTE);
  const emailRepUgIn   = norm(p.EMAIL_REP_UG);
  const emailEnte = isEmail(emailEnteIn) ? emailEnteIn : (isEmail(emailRepEnteIn) ? emailRepEnteIn : '');
  const emailUg   = isEmail(emailUgIn)   ? emailUgIn   : (isEmail(emailRepUgIn)   ? emailRepUgIn   : '');
  if (!emailEnte && !emailUg) return;

  const sCnpj = await getSheetStrict('CNPJ_ENTE_UG');
  await sCnpj.loadHeaderRow();
  await ensureSheetHasColumns(sCnpj, ['EMAIL_ENTE', 'EMAIL_UG']);
  const headers = sCnpj.headerValues || [];
  const san = s => (s ?? '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  const idxOf = name => headers.findIndex(h => san(h) === san(name));

  const col = {
    cnpj_ente:  idxOf('CNPJ_ENTE'),
    cnpj_ug:    idxOf('CNPJ_UG'),
    email_ente: idxOf('EMAIL_ENTE'),
    email_ug:   idxOf('EMAIL_UG'),
  };
  if (col.cnpj_ente < 0 && col.cnpj_ug < 0) return;

  const endRow = sCnpj.rowCount || 2000;
  const endCol = headers.length || sCnpj.columnCount || 26;

  await safeLoadCells(
    sCnpj,
    { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol },
    'CNPJ:updateEmails:loadCells'
  );

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
      const next = sanitizeIfStr(emailEnte);
      if (prev !== next) { cell.value = next; changed++; }
    }
    if (emailUg && col.email_ug >= 0) {
      const cell = sCnpj.getCell(r, col.email_ug);
      const prev = norm(cell.value || '');
      const next = sanitizeIfStr(emailUg);
      if (prev !== next) { cell.value = next; changed++; }
    }
  }
  if (changed) {
    await withLimiter('CNPJ:saveUpdatedCells', () =>
      withTimeoutAndRetry('CNPJ:saveUpdatedCells', () => sCnpj.saveUpdatedCells())
    );
  }
}

/* ---------- busca rápida por CPF ---------- */
async function findRepByCpfFast(cpfDigits) {
  const sReps = await getSheetStrict('Dados_REP_ENTE_UG');
  await sReps.loadHeaderRow();
  const headers = sReps.headerValues || [];
  const san = s => (s ?? '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '');
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
  await safeLoadCells(sReps, { startRowIndex: 1, startColumnIndex: idx.CPF, endRowIndex: endRow, endColumnIndex: idx.CPF + 1 }, 'Reps:scanCPF');

  let rowHit = -1;
  for (let r = 1; r < endRow; r++) {
    const v = digits(sReps.getCell(r, idx.CPF)?.value || '');
    if (v && v === cpfDigits) { rowHit = r; break; }
  }
  if (rowHit < 0) return null;

  const endCol = headers.length || sReps.columnCount || 26;
  await safeLoadCells(sReps, { startRowIndex: rowHit, startColumnIndex: 0, endRowIndex: rowHit + 1, endColumnIndex: endCol }, 'Reps:readRow');

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
  } catch { return ''; }
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

/** POST /api/gescon/termo-enc  { cnpj } */
app.post('/api/gescon/termo-enc', async (req, res) => {
  try {
    const body = validateOr400(res, schemaGesconTermoEnc, req.body || {});
    if (!body) return;

    const cnpj = cnpj14(body.cnpj);
    await authSheets();
    const s = await getSheetStrict('TERMO_ENC_GESCON');

    await s.loadHeaderRow();
    const headers = s.headerValues || [];
    const san = (s) => (s ?? '').toString().trim().toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\p{L}\p{N}]+/gu,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');

    const idxOf = name => headers.findIndex(h => san(h) === san(name));
    const col = {
      cnpj_ente: idxOf('CNPJ_ENTE'),
      uf:        idxOf('UF'),
      ente:      idxOf('ENTE'),
      n_gescon:  idxOf('N_GESCON'),
      data_enc:  idxOf('DATA_ENC_VIA_GESCON'),
    };

    if (col.cnpj_ente < 0) {
      return res.status(500).json({ error: 'Aba TERMO_ENC_GESCON sem coluna CNPJ_ENTE.' });
    }

    const endRow = s.rowCount || 2000;
    await safeLoadCells(s, {
      startRowIndex: 1, startColumnIndex: col.cnpj_ente,
      endRowIndex: endRow, endColumnIndex: col.cnpj_ente + 1
    }, 'GESCON:scanCNPJ');

    let rowHit = -1;
    for (let r = 1; r < endRow; r++) {
      const v = cnpj14(s.getCell(r, col.cnpj_ente)?.value || '');
      if (v && v === cnpj) { rowHit = r; break; }
    }
    if (rowHit < 0) {
      return res.json({}); // front interpreta como “não encontrado”
    }

    const endCol = headers.length || s.columnCount || 26;
    await safeLoadCells(s, {
      startRowIndex: rowHit, startColumnIndex: 0,
      endRowIndex: rowHit + 1, endColumnIndex: endCol
    }, 'GESCON:readRow');

    const dataEncCell = (col.data_enc >= 0) ? s.getCell(rowHit, col.data_enc) : null;
    const normDataEnc = normalizeSheetDateAny(dataEncCell);

    const payload = {
      cnpj,
      uf:        cellStr(s, rowHit, col.uf),
      ente:      cellStr(s, rowHit, col.ente),
      n_gescon:  cellStr(s, rowHit, col.n_gescon),
      // mantém compat p/ o front atual
      data_enc_via_gescon: normDataEnc.dmy || normDataEnc.raw || '',
      // extras (se quiser usar depois)
      data_enc_via_gescon_iso: normDataEnc.iso,
      data_enc_via_gescon_dmy: normDataEnc.dmy
    };



    // se faltar algum essencial, retorna vazio
    if (!payload.n_gescon || !payload.uf || !payload.ente || !payload.data_enc_via_gescon) {
      return res.json({});
    }

    return res.json(payload);
  } catch (e) {
    console.error('❌ /api/gescon/termo-enc:', e);
    const msg = String(e?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    return res.status(500).json({ error: 'Falha ao consultar encaminhamento no Gescon.' });
  }
});


/** POST /api/termos-registrados  { cnpj } */
app.post('/api/termos-registrados', async (req, res) => {
  try {
    const body = validateOr400(res, schemaTermosRegistradosByCnpj, req.body || {});
    if (!body) return;
    const cnpj = cnpj14(body.cnpj);

    await authSheets();

    const sBase = await getSheetStrict('CNPJ_ENTE_UG');
    const sTerm = await getSheetStrict('Termos_registrados');
    const sCrp  = await getSheetStrict('CRP');

    // 1) Base CNPJ_ENTE_UG
    await sBase.loadHeaderRow();
    const headersB = sBase.headerValues || [];
    const san = (s) => (s ?? '').toString().trim().toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\p{L}\p{N}]+/gu,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
    const idxB = {
      UF: headersB.findIndex(h => san(h)==='uf'),
      ENTE: headersB.findIndex(h => san(h)==='ente'),
      UG: headersB.findIndex(h => san(h)==='ug'),
      CNPJ_ENTE: headersB.findIndex(h => san(h)==='cnpj_ente'),
      CNPJ_UG: headersB.findIndex(h => san(h)==='cnpj_ug'),
      EMAIL_ENTE: headersB.findIndex(h => san(h)==='email_ente'),
      EMAIL_UG: headersB.findIndex(h => san(h)==='email_ug'),
    };

    const endRowB = sBase.rowCount || 2000;
    let baseRow = -1;

    if (idxB.CNPJ_ENTE >= 0) {
      await safeLoadCells(sBase, {
        startRowIndex: 1, startColumnIndex: idxB.CNPJ_ENTE,
        endRowIndex: endRowB, endColumnIndex: idxB.CNPJ_ENTE + 1
      }, 'TR:scanCNPJ_ENTE');
      for (let r = 1; r < endRowB; r++) {
        const v = cnpj14(sBase.getCell(r, idxB.CNPJ_ENTE)?.value || '');
        if (v && v === cnpj) { baseRow = r; break; }
      }
    }
    if (baseRow < 0 && idxB.CNPJ_UG >= 0) {
      await safeLoadCells(sBase, {
        startRowIndex: 1, startColumnIndex: idxB.CNPJ_UG,
        endRowIndex: endRowB, endColumnIndex: idxB.CNPJ_UG + 1
      }, 'TR:scanCNPJ_UG');
      for (let r = 1; r < endRowB; r++) {
        const v = cnpj14(sBase.getCell(r, idxB.CNPJ_UG)?.value || '');
        if (v && v === cnpj) { baseRow = r; break; }
      }
    }

    let entePayload = { uf:'', nome:'', cnpj:'', ug:'', cnpj_ug:'', email:'', email_ug:'' };

    if (baseRow >= 0) {
      const endColB = headersB.length || sBase.columnCount || 26;
      await safeLoadCells(sBase, {
        startRowIndex: baseRow, startColumnIndex: 0,
        endRowIndex: baseRow + 1, endColumnIndex: endColB
      }, 'TR:readBaseRow');

      const getB = (c) => (c >= 0 ? (sBase.getCell(baseRow, c)?.value ?? '') : '');
      entePayload = {
        uf:        (getB(idxB.UF) ?? '').toString().trim(),
        nome:      (getB(idxB.ENTE) ?? '').toString().trim(),
        cnpj:      cnpj14(getB(idxB.CNPJ_ENTE)) || cnpj,
        ug:        (getB(idxB.UG) ?? '').toString().trim(),
        cnpj_ug:   cnpj14(getB(idxB.CNPJ_UG)),
        email:     (getB(idxB.EMAIL_ENTE) ?? '').toString().trim(),
        email_ug:  (getB(idxB.EMAIL_UG) ?? '').toString().trim()
      };
    }

    // 2) Último termo em Termos_registrados
    await sTerm.loadHeaderRow();
    const rowsT = await safeGetRows(sTerm, 'Termos_registrados:getRows');
    const matches = rowsT.filter(r => {
      const ce = cnpj14(getVal(r,'CNPJ_ENTE') || '');
      const cu = cnpj14(getVal(r,'CNPJ_UG') || '');
      return (ce && ce === cnpj) || (cu && cu === cnpj);
    });

    const last = matches[matches.length - 1] || {};

    const responsaveisPayload = {
      ente: {
        nome:  (getVal(last,'NOME_REP_ENTE') || '').toString().trim(),
        cpf:   digits(getVal(last,'CPF_REP_ENTE')),
        cargo: (getVal(last,'CARGO_REP_ENTE') || '').toString().trim(),
        email: (getVal(last,'EMAIL_REP_ENTE') || '').toString().trim(),
        telefone: (getVal(last,'TEL_REP_ENTE') || '').toString().trim(),
      },
      ug: {
        nome:  (getVal(last,'NOME_REP_UG') || '').toString().trim(),
        cpf:   digits(getVal(last,'CPF_REP_UG')),
        cargo: (getVal(last,'CARGO_REP_UG') || '').toString().trim(),
        email: (getVal(last,'EMAIL_REP_UG') || '').toString().trim(),
        telefone: (getVal(last,'TEL_REP_UG') || '').toString().trim(),
      }
    };

    const criteriosStr = (getVal(last,'CRITERIOS_IRREGULARES') || '').toString().trim();
    const criteriosArr = criteriosStr ? criteriosStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    // 3) CRP (rápido)
    const crpFast = await findCRPByCnpjFast(sCrp, cnpj) || {};
    const tipo = (crpFast.DECISAO_JUDICIAL || '').toString().trim();
    const crpPayload = {
      data_venc: crpFast.DATA_VALIDADE_ISO || '',
      tipo: /jud/i.test(tipo) ? 'Judicial' : (tipo ? 'Administrativa' : '')
    };

    // Completa ente com dados do último termo se base estiver vazia
    if (!entePayload.uf && last) {
      entePayload.uf = (getVal(last,'UF') || '').toString().trim();
      entePayload.nome = (getVal(last,'ENTE') || '').toString().trim();
      entePayload.cnpj = cnpj14(getVal(last,'CNPJ_ENTE') || cnpj);
      entePayload.ug = (getVal(last,'UG') || '').toString().trim();
      entePayload.cnpj_ug = cnpj14(getVal(last,'CNPJ_UG') || '');
      entePayload.email = (getVal(last,'EMAIL_ENTE') || '').toString().trim();
      entePayload.email_ug = (getVal(last,'EMAIL_UG') || '').toString().trim();
    }

    const esfera = esferaFromEnte(entePayload.nome || getVal(last,'ENTE') || '');

    // e no objeto de resposta final, inclua "esfera"
    return res.json({
      ente: { ...entePayload, esfera },
      responsaveis: responsaveisPayload,
      crp: { ...crpPayload, irregulares: criteriosArr }
    });

  } catch (e) {
    console.error('❌ /api/termos-registrados:', e);
    const msg = String(e?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    return res.status(500).json({ error: 'Falha ao montar dados dos Termos_registrados.' });
  }
});
/* ===== Joi Schemas (novos) ===== */
const schemaGesconTermoEnc = Joi.object({
  cnpj: Joi.string().pattern(/^\D*\d{14}\D*$/).required()
});

const schemaTermosRegistradosByCnpj = Joi.object({
  cnpj: Joi.string().pattern(/^\D*\d{14}\D*$/).required()
});


/* ===== Joi Schemas ===== */
const schemaUpsertCnpj = Joi.object({
  UF: Joi.string().trim().min(1).required(),
  ENTE: Joi.string().trim().min(1).required(),
  UG: Joi.string().trim().allow(''),
  CNPJ_ENTE: Joi.string().pattern(/^\D*\d{14}\D*$/).allow(''),
  CNPJ_UG: Joi.string().pattern(/^\D*\d{14}\D*$/).allow(''),
  EMAIL_ENTE: Joi.string().email().allow(''),
  EMAIL_UG: Joi.string().email().allow(''),
}).unknown(true);

const schemaUpsertRep = Joi.object({
  UF: Joi.string().trim().min(1).required(),
  ENTE: Joi.string().trim().min(1).required(),
  UG: Joi.string().trim().allow(''),
  NOME: Joi.string().trim().min(2).required(),
  CPF: Joi.string().pattern(/^\D*\d{11}\D*$/).required(),
  EMAIL: Joi.string().email().allow(''),
  TELEFONE: Joi.string().allow(''),
  CARGO: Joi.string().trim().allow(''),
}).unknown(true);

const schemaGerarTermo = Joi.object({
  UF: Joi.string().trim().min(1).required(),
  ENTE: Joi.string().trim().min(1).required(),
  CNPJ_ENTE: Joi.string().pattern(/^\D*\d{14}\D*$/).required(),
  UG: Joi.string().trim().min(1).required(),
  CNPJ_UG: Joi.string().pattern(/^\D*\d{14}\D*$/).required(),
  NOME_REP_ENTE: Joi.string().trim().min(2).required(),
  CPF_REP_ENTE: Joi.string().pattern(/^\D*\d{11}\D*$/).required(),
  CARGO_REP_ENTE: Joi.string().trim().min(2).required(),
  EMAIL_REP_ENTE: Joi.string().email().allow(''),
  NOME_REP_UG: Joi.string().trim().min(2).required(),
  CPF_REP_UG: Joi.string().pattern(/^\D*\d{11}\D*$/).required(),
  CARGO_REP_UG: Joi.string().trim().min(2).required(),
  EMAIL_REP_UG: Joi.string().email().allow(''),
  EMAIL_ENTE: Joi.string().email().allow(''),
  EMAIL_UG: Joi.string().email().allow(''),
  DATA_VENCIMENTO_ULTIMO_CRP: Joi.string().trim().min(4).required(),
  TIPO_EMISSAO_ULTIMO_CRP: Joi.string().trim().min(1).required(),
  CRITERIOS_IRREGULARES: Joi.alternatives().try(
    Joi.array().items(Joi.string().trim()),
    Joi.string().allow('')
  ).optional(),
  CELEBRACAO_TERMO_PARCELA_DEBITOS: Joi.string().allow(''),
  REGULARIZACAO_PENDEN_ADMINISTRATIVA: Joi.string().allow(''),
  DEFICIT_ATUARIAL: Joi.string().allow(''),
  CRITERIOS_ESTRUT_ESTABELECIDOS: Joi.string().allow(''),
  MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: Joi.string().allow(''),
  COMPROMISSO_FIRMADO_ADESAO: Joi.string().allow(''),
  PROVIDENCIA_NECESS_ADESAO: Joi.string().allow(''),
  CONDICAO_VIGENCIA: Joi.string().allow(''),
  __snapshot_base: Joi.object().unknown(true).optional(),
  __user_changed_fields: Joi.array().items(Joi.string()).optional(),
  IDEMP_KEY: Joi.string().allow(''),
}).unknown(true);



const schemaTermoPdf = Joi.object({
  UF: Joi.string().allow(''),
  ENTE: Joi.string().allow(''),
  CNPJ_ENTE: Joi.string().allow(''),
  UG: Joi.string().allow(''),
  CNPJ_UG: Joi.string().allow(''),
  NOME_REP_ENTE: Joi.string().allow(''),
  CPF_REP_ENTE: Joi.string().allow(''),
  CARGO_REP_ENTE: Joi.string().allow(''),
  EMAIL_REP_ENTE: Joi.string().allow(''),
  NOME_REP_UG: Joi.string().allow(''),
  CPF_REP_UG: Joi.string().allow(''),
  CARGO_REP_UG: Joi.string().allow(''),
  EMAIL_REP_UG: Joi.string().allow(''),
  DATA_VENCIMENTO_ULTIMO_CRP: Joi.string().allow(''),
  TIPO_EMISSAO_ULTIMO_CRP: Joi.string().allow(''),
  CRITERIOS_IRREGULARES: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()).optional(),
  CELEBRACAO_TERMO_PARCELA_DEBITOS: Joi.string().allow(''),
  REGULARIZACAO_PENDEN_ADMINISTRATIVA: Joi.string().allow(''),
  DEFICIT_ATUARIAL: Joi.string().allow(''),
  CRITERIOS_ESTRUT_ESTABELECIDOS: Joi.string().allow(''),
  MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: Joi.string().allow(''),
  COMPROMISSO_FIRMADO_ADESAO: Joi.string().allow(''),
  PROVIDENCIA_NECESS_ADESAO: Joi.string().allow(''),
  CONDICAO_VIGENCIA: Joi.string().allow(''),
  DATA_TERMO_GERADO: Joi.string().allow(''),
}).unknown(true);

/* === PDF: schema para Termo de Solicitação de CRP Emergencial === */
const schemaTermoSolicPdf = Joi.object({
  // Identificação do ente/UG
  UF: Joi.string().allow(''),
  ENTE: Joi.string().allow(''),
  CNPJ_ENTE: Joi.string().allow(''),
  EMAIL_ENTE: Joi.string().allow(''),
  UG: Joi.string().allow(''),
  CNPJ_UG: Joi.string().allow(''),
  EMAIL_UG: Joi.string().allow(''),
  ESFERA: Joi.string().allow(''),

  // Representantes (ente)
  NOME_REP_ENTE: Joi.string().allow(''),
  CPF_REP_ENTE: Joi.string().allow(''),
  CARGO_REP_ENTE: Joi.string().allow(''),
  EMAIL_REP_ENTE: Joi.string().allow(''),
  TEL_REP_ENTE: Joi.string().allow(''),

  // Representantes (UG)
  NOME_REP_UG: Joi.string().allow(''),
  CPF_REP_UG: Joi.string().allow(''),
  CARGO_REP_UG: Joi.string().allow(''),
  EMAIL_REP_UG: Joi.string().allow(''),
  TEL_REP_UG: Joi.string().allow(''),

  // CRP
  DATA_VENCIMENTO_ULTIMO_CRP: Joi.string().allow(''),
  TIPO_EMISSAO_ULTIMO_CRP: Joi.string().allow(''),
  CRITERIOS_IRREGULARES: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()).optional(),

  // Fase 4 (seleção e dados por sub-bloco)
  FASE_PROGRAMA: Joi.string().valid('4.1','4.2','4.3','4.4','4.5','4.6').allow(''),
  F41_OPCAO: Joi.string().allow(''),

  F42_LISTA: Joi.array().items(Joi.string()).optional(),

  F43_LISTA: Joi.array().items(Joi.string()).optional(),
  F43_JUST: Joi.string().allow(''),
  F43_PLANO: Joi.string().allow(''),

  F44_CRITERIOS: Joi.array().items(Joi.string()).optional(),
  F44_DECLS: Joi.array().items(Joi.string()).optional(),
  F44_FINALIDADES: Joi.array().items(Joi.string()).optional(),
  F44_ANEXOS: Joi.string().allow(''),

  F45_OK451: Joi.boolean().optional(),
  F45_DOCS: Joi.string().allow(''),
  F45_JUST: Joi.string().allow(''),

  F46_CRITERIOS: Joi.array().items(Joi.string()).optional(),
  F46_PROGESTAO: Joi.string().allow(''),
  F46_PORTE: Joi.string().allow(''),
  F46_JUST_D: Joi.string().allow(''),
  F46_DOCS_D: Joi.string().allow(''),
  F46_JUST_E: Joi.string().allow(''),
  F46_DOCS_E: Joi.string().allow(''),
  F46_FINALIDADES: Joi.array().items(Joi.string()).optional(),
  F46_ANEXOS: Joi.string().allow(''),
  F46_JUST_PLANOS: Joi.string().allow(''),
  F46_COMP_CUMPR: Joi.string().allow(''),

  // Justificativas gerais
  JUSTIFICATIVAS_GERAIS: Joi.string().allow(''),

  // Metadados Gescon exibidos no subtítulo
  HAS_TERMO_ENC_GESCON: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  N_GESCON: Joi.string().allow(''),
  DATA_ENC_VIA_GESCON: Joi.string().allow(''),

  // Carimbos
  DATA_SOLIC_GERADA: Joi.string().allow(''),
  HORA_SOLIC_GERADA: Joi.string().allow(''),
  DATA_TERMO_GERADO: Joi.string().allow(''),
  HORA_TERMO_GERADO: Joi.string().allow(''),
}).unknown(true);


/* ===== CRP (Solicitação) — Joi Schemas ===== */
const schemaSolicCrp = Joi.object({
  // básicos (obrigatórios como no front)
  ESFERA: Joi.string().allow(''),
  UF: Joi.string().trim().min(1).required(),
  ENTE: Joi.string().trim().min(1).required(),
  CNPJ_ENTE: Joi.string().pattern(/^\D*\d{14}\D*$/).required(),
  EMAIL_ENTE: Joi.string().email().allow(''),
  UG: Joi.string().trim().min(1).required(),
  CNPJ_UG: Joi.string().pattern(/^\D*\d{14}\D*$/).required(),
  EMAIL_UG: Joi.string().email().allow(''),

  // reps
  CPF_REP_ENTE: Joi.string().pattern(/^\D*\d{11}\D*$/).required(),
  NOME_REP_ENTE: Joi.string().trim().min(2).required(),
  CARGO_REP_ENTE: Joi.string().trim().min(1).required(),
  EMAIL_REP_ENTE: Joi.string().email().allow(''),
  TEL_REP_ENTE: Joi.string().allow(''),

  CPF_REP_UG: Joi.string().pattern(/^\D*\d{11}\D*$/).required(),
  NOME_REP_UG: Joi.string().trim().min(2).required(),
  CARGO_REP_UG: Joi.string().trim().min(1).required(),
  EMAIL_REP_UG: Joi.string().email().allow(''),
  TEL_REP_UG: Joi.string().allow(''),

  // etapa 3
  DATA_VENCIMENTO_ULTIMO_CRP: Joi.string().trim().min(4).required(),
  TIPO_EMISSAO_ULTIMO_CRP: Joi.string().valid('Administrativa','Judicial').required(),
  CRITERIOS_IRREGULARES: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string().allow('')).optional(),

  // etapa 4 (tudo opcional; front valida a combinação)
  FASE_PROGRAMA: Joi.string().valid('4.1','4.2','4.3','4.4','4.5','4.6').allow(''),
  F41_OPCAO: Joi.string().allow(''),
  F42_LISTA: Joi.array().items(Joi.string()).optional(),
  F43_LISTA: Joi.array().items(Joi.string()).optional(),
  F43_JUST: Joi.string().allow(''),
  F43_PLANO: Joi.string().allow(''),
  F44_CRITERIOS: Joi.array().items(Joi.string()).optional(),
  F44_DECLS: Joi.array().items(Joi.string()).optional(),
  F44_FINALIDADES: Joi.array().items(Joi.string()).optional(),
  F44_ANEXOS: Joi.string().allow(''),
  F45_OK451: Joi.boolean().optional(),
  F45_DOCS: Joi.string().allow(''),
  F45_JUST: Joi.string().allow(''),
  F46_CRITERIOS: Joi.array().items(Joi.string()).optional(),
  F46_PROGESTAO: Joi.string().allow(''),
  F46_PORTE: Joi.string().allow(''),
  F46_JUST_D: Joi.string().allow(''),
  F46_DOCS_D: Joi.string().allow(''),
  F46_JUST_E: Joi.string().allow(''),
  F46_DOCS_E: Joi.string().allow(''),
  F46_FINALIDADES: Joi.array().items(Joi.string()).optional(),
  F46_ANEXOS: Joi.string().allow(''),
  F46_JUST_PLANOS: Joi.string().allow(''),
  F46_COMP_CUMPR: Joi.string().allow(''),

  // etapa 5
  JUSTIFICATIVAS_GERAIS: Joi.string().allow(''),

  // carimbos
  MES: Joi.string().allow(''),
  DATA_SOLIC_GERADA: Joi.string().allow(''),
  HORA_SOLIC_GERADA: Joi.string().allow(''),
  ANO_SOLIC_GERADA: Joi.string().allow(''),

  // gescon (gate informativo)
  HAS_TERMO_ENC_GESCON: Joi.boolean().optional(),
  N_GESCON: Joi.string().allow(''),
  DATA_ENC_VIA_GESCON: Joi.string().allow(''),

  IDEMP_KEY: Joi.string().allow('')
}).unknown(true);

const schemaSolicCrpPdf = schemaSolicCrp.fork(
  Object.keys(schemaSolicCrp.describe().keys),
  (s) => s.optional()
).unknown(true);



function validateOr400(res, schema, obj) {
  const { error, value } = schema.validate(obj, { abortEarly: false, stripUnknown: false, convert: true });
  if (error) {
    res.status(400).json({ error: 'VALIDATION', details: error.details.map(d => d.message) });
    return null;
  }
  return value;
}

/* util: upsert representante */
async function upsertRep({ UF, ENTE, UG, NOME, CPF, EMAIL, TELEFONE, CARGO }) {
  const sReps = await getOrCreateSheet('Dados_REP_ENTE_UG', ['UF','ENTE','NOME','CPF','EMAIL','TELEFONE','TELEFONE_MOVEL','CARGO','UG']);
  const rows = await safeGetRows(sReps, 'Reps:getRows');
  const cpf = digits(CPF);
  let row = rows.find(r => digits(getVal(r,'CPF')) === cpf);

  const telBase = norm(TELEFONE);
  const ugFinal = await resolveUGIfBlank(UF, ENTE, UG);

  if (!row) {
    await safeAddRow(sReps, sheetSanObject({
      UF: norm(UF), ENTE: norm(ENTE), NOME: norm(NOME),
      CPF: cpf, EMAIL: norm(EMAIL),
      TELEFONE: telBase, TELEFONE_MOVEL: telBase,
      CARGO: norm(CARGO), UG: ugFinal
    }), 'Reps:add');
    return { created: true };
  }

  if (typeof row.save === 'function') {
    row['UF']   = sanitizeIfStr(norm(UF)   || row['UF']);
    row['ENTE'] = sanitizeIfStr(norm(ENTE) || row['ENTE']);
    row['UG']   = sanitizeIfStr(ugFinal    || row['UG']);
    row['NOME'] = sanitizeIfStr(norm(NOME) || row['NOME']);
    row['EMAIL']= sanitizeIfStr(norm(EMAIL)|| row['EMAIL']);
    if (telBase) { row['TELEFONE'] = sanitizeIfStr(telBase); row['TELEFONE_MOVEL'] = sanitizeIfStr(telBase); }
    row['CARGO']= sanitizeIfStr(norm(CARGO)|| row['CARGO']);
    await safeSaveRow(row, 'Reps:save');
    return { updated: true };
  }

  // fallback por células
  await sReps.loadHeaderRow();
  const headers = sReps.headerValues || [];
  const san = s => (s ?? '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  const idxOf = name => headers.findIndex(h => san(h) === san(name));
  const colCPF = idxOf('CPF');

  const endRow = sReps.rowCount || 2000;
  const endCol = headers.length || sReps.columnCount || 26;
  await safeLoadCells(sReps, { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol }, 'Reps:updateCells');

  let rIdx = -1;
  for (let r = 1; r < endRow; r++) {
    const v = digits(sReps.getCell(r, colCPF)?.value || '');
    if (v && v === cpf) { rIdx = r; break; }
  }
  if (rIdx < 0) {
    await safeAddRow(sReps, sheetSanObject({ UF: norm(UF), ENTE: norm(ENTE), NOME: norm(NOME), CPF: cpf, EMAIL: norm(EMAIL), TELEFONE: telBase, TELEFONE_MOVEL: telBase, CARGO: norm(CARGO), UG: ugFinal }), 'Reps:add(fallback)');
    return { created: true };
  }

  const setCell = (name, val) => { const c = idxOf(name); if (c >= 0 && norm(val)) sReps.getCell(rIdx, c).value = sanitizeIfStr(norm(val)); };
  setCell('UF', UF); setCell('ENTE', ENTE); setCell('UG', ugFinal);
  setCell('NOME', NOME); setCell('EMAIL', EMAIL);
  setCell('TELEFONE', telBase); setCell('TELEFONE_MOVEL', telBase);
  setCell('CARGO', CARGO);

  await withLimiter('Reps:saveUpdatedCells', () => withTimeoutAndRetry('Reps:saveUpdatedCells', () => sReps.saveUpdatedCells()));
  return { updated: true };
}

/* util: upsert base do ente/UG quando o CNPJ pesquisado não existir */
async function upsertCNPJBase({ UF, ENTE, UG, CNPJ_ENTE, CNPJ_UG, EMAIL_ENTE, EMAIL_UG }){
  const s = await getOrCreateSheet('CNPJ_ENTE_UG', ['UF','ENTE','UG','CNPJ_ENTE','CNPJ_UG','EMAIL_ENTE','EMAIL_UG']);
  await s.loadHeaderRow();
  const headers = s.headerValues || [];
  const san = s => (s ?? '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'_')
    .replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  const idxOf = name => headers.findIndex(h => san(h) === san(name));
  const col = {
    uf: idxOf('UF'), ente: idxOf('ENTE'), ug: idxOf('UG'),
    cnpj_ente: idxOf('CNPJ_ENTE'), cnpj_ug: idxOf('CNPJ_UG'),
    email_ente: idxOf('EMAIL_ENTE'), email_ug: idxOf('EMAIL_UG'),
  };

  const ce = cnpj14(CNPJ_ENTE);
  const cu = cnpj14(CNPJ_UG);

  const endRow = s.rowCount || 2000;
  const endCol = headers.length || s.columnCount || 26;

  await safeLoadCells(s, { startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol }, 'CNPJ:addOrUpdate:loadCells');

  let foundRow = -1;
  for (let r = 1; r < endRow; r++) {
    let hit = false;
    if (col.cnpj_ente >= 0) {
      const v = cnpj14(s.getCell(r, col.cnpj_ente)?.value || ''); if (v && ce && v === ce) hit = true;
    }
    if (!hit && col.cnpj_ug >= 0) {
      const v = cnpj14(s.getCell(r, col.cnpj_ug)?.value || ''); if (v && cu && v === cu) hit = true;
    }
    if (hit) { foundRow = r; break; }
  }

  if (foundRow < 0) {
    await safeAddRow(s, sheetSanObject({ UF: norm(UF), ENTE: norm(ENTE), UG: norm(UG), CNPJ_ENTE: ce, CNPJ_UG: cu, EMAIL_ENTE: norm(EMAIL_ENTE), EMAIL_UG: norm(EMAIL_UG) }), 'CNPJ:addRow');
    return { created: true };
  }

  let changed = 0;
  const setCellIf = (cIdx, val, transform = x => x) => {
    if (cIdx < 0 || val == null) return;
    const cell = s.getCell(foundRow, cIdx);
    const cur  = norm(cell.value || '');
    const nxt  = sanitizeIfStr(norm(transform(val)));
    if (cur !== nxt) { cell.value = nxt; changed++; }
  };
  setCellIf(col.uf, UF); setCellIf(col.ente, ENTE); setCellIf(col.ug, UG);
  setCellIf(col.cnpj_ente, ce); setCellIf(col.cnpj_ug, cu);
  setCellIf(col.email_ente, EMAIL_ENTE); setCellIf(col.email_ug, EMAIL_UG);

  if (changed) {
    await withLimiter('CNPJ:saveUpdatedCells', () => withTimeoutAndRetry('CNPJ:saveUpdatedCells', () => s.saveUpdatedCells()));
    return { updated: true };
  }
  return { updated: false };
}

/* ===== util de idempotência ===== */
function makeIdemKeyFromPayload(p) {
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
    TS_DIA: String(p.DATA_TERMO_GERADO || ''),
  };
  const raw = JSON.stringify(keyObj);
  return 'fp_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/* ===== Idempotência p/ Solic_CRPs ===== */
function makeIdemKeyFromSolicCrp(p) {
  const keyObj = {
    UF: norm(p.UF), ENTE: norm(p.ENTE),
    CNPJ_ENTE: cnpj14(p.CNPJ_ENTE),
    CNPJ_UG: cnpj14(p.CNPJ_UG),
    CPF_REP_ENTE: digits(p.CPF_REP_ENTE),
    CPF_REP_UG: digits(p.CPF_REP_UG),
    DATA_VENC: norm(p.DATA_VENCIMENTO_ULTIMO_CRP),
    FASE: norm(p.FASE_PROGRAMA || ''),
    DIA: norm(p.DATA_SOLIC_GERADA || '')
  };
  return 'sc_' + crypto.createHash('sha256').update(JSON.stringify(keyObj)).digest('hex').slice(0, 24);
}
async function findSolicByIdemKey(sheet, idemKey) {
  await sheet.loadHeaderRow();
  const headers = sheet.headerValues || [];
  const idx = headers.findIndex(h => String(h).trim().toUpperCase() === 'IDEMP_KEY');
  if (idx < 0) return null;
  const endRow = sheet.rowCount || 2000;
  await safeLoadCells(sheet, { startRowIndex: 1, startColumnIndex: idx, endRowIndex: endRow, endColumnIndex: idx+1 }, 'SolicCRP:scanIDEMP');
  for (let r=1;r<endRow;r++){
    const v = String(sheet.getCell(r, idx)?.value || '').trim();
    if (v && v === idemKey) return r;
  }
  return null;
}
const SOLIC_HEADERS = [
  'ESFERA','UF','ENTE','CNPJ_ENTE','EMAIL_ENTE',
  'UG','CNPJ_UG','EMAIL_UG',
  'NOME_REP_ENTE','CPF_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE',
  'NOME_REP_UG','CPF_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG',
  'DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP','CRITERIOS_IRREGULARES',
  'FASE_PROGRAMA','F41_OPCAO','F42_LISTA','F43_LISTA','F43_JUST','F43_PLANO',
  'F44_CRITERIOS','F44_DECLS','F44_FINALIDADES','F44_ANEXOS',
  'F45_OK451','F45_DOCS','F45_JUST',
  'F46_CRITERIOS','F46_PROGESTAO','F46_PORTE','F46_JUST_D','F46_DOCS_D','F46_JUST_E','F46_DOCS_E','F46_FINALIDADES','F46_ANEXOS','F46_JUST_PLANOS','F46_COMP_CUMPR',
  'JUSTIFICATIVAS_GERAIS',
  'HAS_TERMO_ENC_GESCON','N_GESCON','DATA_ENC_VIA_GESCON',
  'MES','DATA_SOLIC_GERADA','HORA_SOLIC_GERADA','ANO_SOLIC_GERADA',
  'IDEMP_KEY'
];

async function findTermoByIdemKey(sTermos, idemKey) {
  await sTermos.loadHeaderRow();
  const headers = sTermos.headerValues || [];
  const idx = headers.findIndex(h => String(h).trim().toUpperCase() === 'IDEMP_KEY');
  if (idx < 0) return null;

  const endRow = sTermos.rowCount || 2000;
  await safeLoadCells(sTermos, { startRowIndex: 1, startColumnIndex: idx, endRowIndex: endRow, endColumnIndex: idx + 1 }, 'Termos:scanIDEMP');

  for (let r = 1; r < endRow; r++) {
    const v = String(sTermos.getCell(r, idx)?.value || '').trim();
    if (v && v === idemKey) return r;
  }
  return null;
}

app.post('/api/upsert-cnpj', async (req,res)=>{
  try{
    const clean = validateOr400(res, schemaUpsertCnpj, req.body || {});
    if (!clean) return;
    await authSheets();
    const r = await upsertCNPJBase(clean);
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
    const clean = validateOr400(res, schemaUpsertRep, req.body || {});
    if (!clean) return;

    // normalizações consistentes com validação
    clean.CPF = digits(clean.CPF);
    await authSheets();
    const r = await upsertRep(clean);
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

async function logAlteracoesInline(p, snapshotRaw = {}) {
  const sLog = await getOrCreateSheet('Reg_alteracao_dados_ente_ug', [
    'UF','ENTE','CAMPOS ALTERADOS','QTD_CAMPOS_ALTERADOS','MES','DATA','HORA'
  ]);
  await sLog.loadHeaderRow();
  await ensureSheetHasColumns(sLog, ['UF','ENTE','CAMPOS ALTERADOS','QTD_CAMPOS_ALTERADOS','MES','DATA','HORA']);
  const snap = snapshotRaw || {};
  const WATCH = [
    'UF','ENTE','CNPJ_ENTE','EMAIL_ENTE',
    'UG','CNPJ_UG','EMAIL_UG',
    'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
    'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG',
    'DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP'
  ];

  const changed = [];
  for (const col of WATCH) {
    const normOld = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL'))
      ? String(snap[col] ?? '').replace(/\D+/g,'')
      : String(snap[col] ?? '').trim();
    const normNew = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL'))
      ? String(p[col] ?? '').replace(/\D+/g,'')
      : String(p[col] ?? '').trim();

    const hasSnap = Object.keys(snap).length > 0;
    const diff = hasSnap ? (normOld.toLowerCase() !== normNew.toLowerCase()) : !!normNew;
    if (diff) changed.push(col);
  }

  const edited = Array.isArray(p.__user_changed_fields) ? p.__user_changed_fields : [];
  const editedWatched = edited.filter(k => WATCH.includes(k));
  const finalChanged = [...new Set([...editedWatched, ...changed])];

  if (!finalChanged.length) return 0;

  const t = nowBR();

  await safeAddRow(sLog, sheetSanObject({
    UF: (p.UF || '').trim(),
    ENTE: (p.ENTE || '').trim(),
    'CAMPOS ALTERADOS': finalChanged.join(', '),
    'QTD_CAMPOS_ALTERADOS': finalChanged.length,
    MES: t.MES, DATA: t.DATA, HORA: t.HORA
  }), 'Reg_alteracao:add');

  return finalChanged.length;
}

/** POST /api/gerar-termo  — IDEMPOTENTE */
app.post('/api/gerar-termo', async (req, res) => {
  try {
    const validated = validateOr400(res, schemaGerarTermo, req.body || {});
    if (!validated) return;
    const p = validated;

    await authSheets();

    const sTermosSheet = await getOrCreateSheet('Termos_registrados', [
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
      'IDEMP_KEY'
    ]);
    await sTermosSheet.loadHeaderRow();
    await ensureSheetHasColumns(sTermosSheet, ['IDEMP_KEY']);

    // Idempotência
    const idemHeader = String(req.headers['x-idempotency-key'] || '').trim();
    const idemBody   = String(p.IDEMP_KEY || '').trim();
    const idemKey    = idemHeader || idemBody || makeIdemKeyFromPayload(p);

    const existingRowIdx = await findTermoByIdemKey(sTermosSheet, idemKey);

    const snapshot = (p && p.__snapshot_base) || {};
    const warnings = [];
    let logStatus = 'skip';

    if (existingRowIdx !== null) {
      try {
        const n = await logAlteracoesInline(p, snapshot);
        logStatus = n ? 'ok' : 'empty';
      } catch (e) {
        logStatus = 'error';
        warnings.push('reg_alteracao_write_failed');
        if (LOG_LEVEL !== 'silent') console.warn('logAlteracoes (dedup):', e?.message || e);
      }
      return res.json({ ok: true, dedup: true, log: logStatus, warnings, idempotency_key: idemKey });
    }

    const criterios = Array.isArray(p.CRITERIOS_IRREGULARES)
      ? p.CRITERIOS_IRREGULARES
      : String(p.CRITERIOS_IRREGULARES || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

    const { DATA, HORA, ANO, MES } = nowBR();

    const emailEnteFinal = isEmail(p.EMAIL_ENTE) ? norm(p.EMAIL_ENTE)
                     : isEmail(p.EMAIL_REP_ENTE) ? norm(p.EMAIL_REP_ENTE) : '';
    const emailUgFinal   = isEmail(p.EMAIL_UG)   ? norm(p.EMAIL_UG)
                     : isEmail(p.EMAIL_REP_UG)   ? norm(p.EMAIL_REP_UG)   : '';

    await safeAddRow(sTermosSheet, sheetSanObject({
      ENTE: norm(p.ENTE), UF: norm(p.UF),
      CNPJ_ENTE: digits(p.CNPJ_ENTE), EMAIL_ENTE: emailEnteFinal,
      NOME_REP_ENTE: norm(p.NOME_REP_ENTE), CARGO_REP_ENTE: norm(p.CARGO_REP_ENTE),
      CPF_REP_ENTE: digits(p.CPF_REP_ENTE), EMAIL_REP_ENTE: norm(p.EMAIL_REP_ENTE),
      UG: norm(p.UG), CNPJ_UG: digits(p.CNPJ_UG), EMAIL_UG:   emailUgFinal,
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
    }), 'Termos:add');

    try { await upsertEmailsInBase(p); } catch (_) {}

    try {
      const n = await logAlteracoesInline(p, snapshot);
      logStatus = n ? 'ok' : 'empty';
    } catch (e) {
      logStatus = 'error';
      warnings.push('reg_alteracao_write_failed');
      if (LOG_LEVEL !== 'silent') console.warn('logAlteracoes:', e?.message || e);
    }

    return res.json({ ok: true, log: logStatus, warnings, idempotency_key: idemKey });

  } catch (err) {
    console.error('❌ /api/gerar-termo:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    return res.status(500).json({ error: 'Falha ao registrar o termo.' });
  }
});

/** POST /api/gerar-solic-crp  — IDEMPOTENTE (Solicitação CRP) */
app.post('/api/gerar-solic-crp', async (req, res) => {
  try {
    const p = validateOr400(res, schemaSolicCrp, req.body || {});
    if (!p) return;

    await authSheets();
    const s = await getOrCreateSheet('Solic_CRPs', SOLIC_HEADERS);
    await ensureMinColumns(s, SOLIC_HEADERS.length);
    await ensureHeaderRow(s, SOLIC_HEADERS);
    await ensureSheetHasColumns(s, ['IDEMP_KEY']);



    const idemHeader = String(req.headers['x-idempotency-key'] || '').trim();
    const idemBody   = String(p.IDEMP_KEY || '').trim();
    const idemKey    = idemHeader || idemBody || makeIdemKeyFromSolicCrp(p);

    const existing = await findSolicByIdemKey(s, idemKey);
    if (existing !== null) {
      return res.json({ ok:true, dedup:true, idempotency_key: idemKey });
    }

    const criterios = Array.isArray(p.CRITERIOS_IRREGULARES)
      ? p.CRITERIOS_IRREGULARES : String(p.CRITERIOS_IRREGULARES||'').split(',').map(v=>v.trim()).filter(Boolean);

    // arrays em CSV
    const asCSV = (a) => Array.isArray(a) ? a.join(', ') : String(a||'');

    await safeAddRow(s, sheetSanObject({
      ESFERA: p.ESFERA || '',
      UF: p.UF, ENTE: p.ENTE, CNPJ_ENTE: digits(p.CNPJ_ENTE), EMAIL_ENTE: norm(p.EMAIL_ENTE),
      UG: p.UG, CNPJ_UG: digits(p.CNPJ_UG), EMAIL_UG: norm(p.EMAIL_UG),
      NOME_REP_ENTE: p.NOME_REP_ENTE, CPF_REP_ENTE: digits(p.CPF_REP_ENTE), CARGO_REP_ENTE: p.CARGO_REP_ENTE, EMAIL_REP_ENTE: norm(p.EMAIL_REP_ENTE), TEL_REP_ENTE: norm(p.TEL_REP_ENTE),
      NOME_REP_UG: p.NOME_REP_UG, CPF_REP_UG: digits(p.CPF_REP_UG), CARGO_REP_UG: p.CARGO_REP_UG, EMAIL_REP_UG: norm(p.EMAIL_REP_UG), TEL_REP_UG: norm(p.TEL_REP_UG),
      DATA_VENCIMENTO_ULTIMO_CRP: norm(p.DATA_VENCIMENTO_ULTIMO_CRP), TIPO_EMISSAO_ULTIMO_CRP: norm(p.TIPO_EMISSAO_ULTIMO_CRP),
      CRITERIOS_IRREGULARES: criterios.join(', '),

      FASE_PROGRAMA: p.FASE_PROGRAMA || '',
      F41_OPCAO: p.F41_OPCAO || '',
      F42_LISTA: asCSV(p.F42_LISTA),
      F43_LISTA: asCSV(p.F43_LISTA), F43_JUST: p.F43_JUST || '', F43_PLANO: p.F43_PLANO || '',
      F44_CRITERIOS: asCSV(p.F44_CRITERIOS), F44_DECLS: asCSV(p.F44_DECLS), F44_FINALIDADES: asCSV(p.F44_FINALIDADES), F44_ANEXOS: p.F44_ANEXOS || '',
      F45_OK451: p.F45_OK451 ? '1' : '', F45_DOCS: p.F45_DOCS || '', F45_JUST: p.F45_JUST || '',
      F46_CRITERIOS: asCSV(p.F46_CRITERIOS), F46_PROGESTAO: p.F46_PROGESTAO || '', F46_PORTE: p.F46_PORTE || '',
      F46_JUST_D: p.F46_JUST_D || '', F46_DOCS_D: p.F46_DOCS_D || '', F46_JUST_E: p.F46_JUST_E || '', F46_DOCS_E: p.F46_DOCS_E || '',
      F46_FINALIDADES: asCSV(p.F46_FINALIDADES), F46_ANEXOS: p.F46_ANEXOS || '', F46_JUST_PLANOS: p.F46_JUST_PLANOS || '', F46_COMP_CUMPR: p.F46_COMP_CUMPR || '',

      JUSTIFICATIVAS_GERAIS: p.JUSTIFICATIVAS_GERAIS || '',

      HAS_TERMO_ENC_GESCON: p.HAS_TERMO_ENC_GESCON ? '1' : '',
      N_GESCON: p.N_GESCON || '', DATA_ENC_VIA_GESCON: p.DATA_ENC_VIA_GESCON || '',

      MES: p.MES || '', DATA_SOLIC_GERADA: p.DATA_SOLIC_GERADA || '', HORA_SOLIC_GERADA: p.HORA_SOLIC_GERADA || '', ANO_SOLIC_GERADA: p.ANO_SOLIC_GERADA || '',
      IDEMP_KEY: idemKey
    }), 'SolicCRP:add');

    try { await upsertEmailsInBase(p); } catch (_) {}

    return res.json({ ok:true, idempotency_key: idemKey });
  } catch (err) {
    console.error('❌ /api/gerar-solic-crp:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout:') || msg.includes('etimedout')) {
      return res.status(504).json({ error: 'Tempo de resposta esgotado. Tente novamente.' });
    }
    return res.status(500).json({ error:'Falha ao registrar a solicitação de CRP.' });
  }
});
/* ========= PDF (Puppeteer) ========= */
const PDF_CONCURRENCY = Number(process.env.PDF_CONCURRENCY || 1);
const _pdfQ = []; let _pdfActive = 0;
function _pdfRunNext() {
  if (_pdfActive >= PDF_CONCURRENCY) return;
  const it = _pdfQ.shift(); if (!it) return;
  _pdfActive++;
  (async () => { try { it.resolve(await it.fn()); } catch (e) { it.reject(e); } finally { _pdfActive--; _pdfRunNext(); } })();
}
function withPdfLimiter(fn) {
  return new Promise((resolve, reject) => { _pdfQ.push({ fn, resolve, reject }); _pdfRunNext(); });
}
const _svgCache = {};
function inlineSvg(relPath) {
  try {
    const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/,''));
    if (_svgCache[abs]) return _svgCache[abs];
    const raw = fs.readFileSync(abs, 'utf8');
    const cleaned = raw.replace(/<\?xml[^>]*>/g, '').replace(/<!DOCTYPE[^>]*>/g, '').replace(/\r?\n|\t/g, ' ').replace(/>\s+</g, '><').trim();
    _svgCache[abs] = cleaned; return cleaned;
  } catch { return ''; }
}
function inlineFont(relPath) {
  try {
    const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/, ''));
    const buf = fs.readFileSync(abs);
    const b64 = buf.toString('base64');
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : 'application/octet-stream';
    const fmt  = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : 'truetype';
    return `url(data:${mime};base64,${b64}) format('${fmt}')`;
  } catch { return null; }
}

app.post('/api/termo-pdf', async (req, res) => {
  try {
    const p = validateOr400(res, schemaTermoPdf, req.body || {});
    if (!p) return;

    await withPdfLimiter(async () => {
      let page; let browser; let triedRestart = false;
      try {
        const compAgg = String(p.COMPROMISSO_FIRMADO_ADESAO || '');
        const compCodes = ['5.1','5.2','5.3','5.4','5.5','5.6','5.7']
          .filter(code => new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`).test(compAgg));

        const qs = new URLSearchParams({
          uf: p.UF || '', ente: p.ENTE || '', cnpj_ente: p.CNPJ_ENTE || '', email_ente: p.EMAIL_ENTE || '',
          ug: p.UG || '', cnpj_ug: p.CNPJ_UG || '', email_ug: p.EMAIL_UG || '',
          esfera: p.ESFERA || '',
          nome_rep_ente: p.NOME_REP_ENTE || '', cpf_rep_ente: p.CPF_REP_ENTE || '', cargo_rep_ente: p.CARGO_REP_ENTE || '', email_rep_ente: p.EMAIL_REP_ENTE || '',
          nome_rep_ug: p.NOME_REP_UG || '', cpf_rep_ug: p.CPF_REP_UG || '', cargo_rep_ug: p.CARGO_REP_UG || '', email_rep_ug: p.EMAIL_REP_UG || '',
          venc_ult_crp: p.DATA_VENCIMENTO_ULTIMO_CRP || '', tipo_emissao_crp: p.TIPO_EMISSAO_ULTIMO_CRP || '',
          celebracao: p.CELEBRACAO_TERMO_PARCELA_DEBITOS || '', regularizacao: p.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '',
          deficit: p.DEFICIT_ATUARIAL || '', criterios_estrut: p.CRITERIOS_ESTRUT_ESTABELECIDOS || '',
          manutencao_normas: p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS || '',
          compromisso: p.COMPROMISSO_FIRMADO_ADESAO || '', providencias: p.PROVIDENCIA_NECESS_ADESAO || '',
          condicao_vigencia: p.CONDICAO_VIGENCIA || '', data_termo: p.DATA_TERMO_GERADO || '', auto: '1'
        });
        (Array.isArray(p.CRITERIOS_IRREGULARES) ? p.CRITERIOS_IRREGULARES : []).forEach((c, i) => qs.append(`criterio${i+1}`, String(c || '')));
        compCodes.forEach(code => qs.append('comp', code));

        // ✅ Não derive URL pública do cabeçalho do request
        const LOOPBACK_BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
        // Se quiser permitir externo, defina PUBLIC_URL fixo no .env (ex.: https://seu-dominio.gov.br)
        const PUBLIC_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');


        try { browser = await getBrowser(); page = await browser.newPage(); }
        catch (e) {
          const msg = String(e?.message || '');
          if (!triedRestart && /Target closed|Browser is closed|WebSocket is not open|TargetCloseError/i.test(msg)) {
            triedRestart = true;
            try { await browser?.close().catch(()=>{}); } catch(_){}
            _browserPromise = null; browser = await getBrowser(); page = await browser.newPage();
          } else { throw e; }
        }

        await page.setCacheEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (reqObj) => {
          const u = reqObj.url();
          if (u === 'about:blank' || u.startsWith('data:')) return reqObj.continue();

          const allowed =
            (u.startsWith(LOOPBACK_BASE)) ||
            (PUBLIC_BASE && u.startsWith(PUBLIC_BASE));

          return allowed ? reqObj.continue() : reqObj.abort();
        });

        page.setDefaultNavigationTimeout(90_000);
        page.setDefaultTimeout(90_000);
        await page.emulateMediaType('screen');

        // 1) carrega a página SEM querystring (evita PII em logs/cache)
        const urlsToTry = [
          `${LOOPBACK_BASE}/termo.html`
        ];
        if (PUBLIC_BASE) {
          urlsToTry.push(`${PUBLIC_BASE}/termo.html`);
        }

        let loaded = false; let lastErr = null;
        for (const u of urlsToTry) {
          try {
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 90_000 });
            loaded = true; break;
          } catch (e) { lastErr = e; }
        }
        if (!loaded) throw lastErr || new Error('Falha ao carregar termo.html');

        // 2) injeta os dados na página após o load
        const payloadForClient = {
          ...p,
          // já que antes você colocava alguns campos na querystring:
          ESFERA: p.ESFERA || '',
          CRITERIOS_IRREGULARES: Array.isArray(p.CRITERIOS_IRREGULARES) ? p.CRITERIOS_IRREGULARES : [],
          // reaproveita os códigos que você calculou lá em cima
          COMP_CODES: compCodes
        };

        await page.evaluate((payload) => {
          window.__TERMO_DATA__ = payload;
          document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
        }, payloadForClient);

              
        await page.waitForSelector('#pdf-root', { timeout: 20_000 }).catch(()=>{});

        // Aguarda o front sinalizar que terminou de preencher (ou timeout curto)
        await page.evaluate(() => new Promise((ok) => {
          if (window.__TERMO_PRINT_READY__ === true) return ok();
          document.addEventListener('TERMO_PRINT_READY', () => ok(), { once: true });
          setTimeout(ok, 1500); // fallback p/ não travar se o evento não vier
        }));

        // aguarda o front sinalizar que terminou a hidratação/render
        await page.evaluate(() => {
          if (!window.__TERMO_WAIT_PRINT__) {
            window.__TERMO_WAIT_PRINT__ = new Promise((resolve) => {
              const done = () => { window.__TERMO_READY = true; resolve(true); };
              document.addEventListener('TERMO_PRINT_READY', done, { once: true });
              setTimeout(done, 2000); // fallback
            });
          }
          return window.__TERMO_WAIT_PRINT__;
        });

        function findFont(candidates){
          for (const rel of candidates){
            const abs = path.join(__dirname, '../frontend', rel.replace(/^\/+/, ''));
            if (fs.existsSync(abs)) return inlineFont(rel);
          }
          return null;
        }
        const rawline400 = findFont(['fonts/rawline-regular.woff2','fonts/rawline-regular.woff','fonts/rawline-regular.ttf','fonts/rawline-400.woff2','fonts/rawline-400.woff','fonts/rawline-400.ttf']);
        const rawline700 = findFont(['fonts/rawline-bold.woff2','fonts/rawline-bold.woff','fonts/rawline-bold.ttf','fonts/rawline-700.woff2','fonts/rawline-700.woff','fonts/rawline-700.ttf']);

        let fontCSS = '';
        if (rawline400) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:400;src:${rawline400};font-display:swap;}`;
        if (rawline700) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:700;src:${rawline700};font-display:swap;}`;
        fontCSS += `body{font-family:'Rawline', Inter, Arial, sans-serif;}`;

        await page.addStyleTag({ content: `
          ${fontCSS}
          html, body, #pdf-root { background:#ffffff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .page-head .logos-wrap { display: none !important; }
          .term-wrap { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
          .term-title { margin-top: 2mm !important; }
        `});
        
        // após page.goto(...), page.addStyleTag(...), page.addScriptTag(...)
        await page.evaluate(() => {
          document.documentElement.classList.add('pdf-export'); // <html>
          document.body.classList.add('pdf-export');            // <body>
        });


        const svgSec = inlineSvg('imagens/logo-secretaria-complementar.svg');
        const svgMps = inlineSvg('imagens/logo-termo-drpps.svg');
        const headerTemplate = `
          <style>
            .pdf-header { font-family: Inter, Arial, sans-serif; width: 100%; padding: 6mm 12mm 4mm; }
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
          </div>`;
        const footerTemplate = `<div></div>`;

        const pdf = await page.pdf({
          printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
          headerTemplate, footerTemplate, margin: { top: '38mm', right: '0mm', bottom: '12mm', left: '0mm' }
        });
        await page.close();

        const filenameSafe = (p.ENTE || 'termo-adesao')
          .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'').toLowerCase();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="termo-${filenameSafe}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.send(pdf);
      } catch (e) {
        console.error('❌ /api/termo-pdf:', e);
        try { if (page) await page.close(); } catch(_) {}
        res.status(500).json({ error: 'Falha ao gerar PDF' });
      }
    });
  } catch (e) {
    console.error('❌ (outer) /api/termo-pdf:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar PDF' });
  }
});

/** POST /api/termo-solic-crp-pdf — gera PDF do termo_solic_crp.html */
app.post('/api/termo-solic-crp-pdf', async (req, res) => {
  try {
    const p = validateOr400(res, schemaTermoSolicPdf, req.body || {});
    if (!p) return;

    await withPdfLimiter(async () => {
      let page; let browser; let triedRestart = false;
      try {
        // Bases internas: loopback e (opcional) PUBLIC_URL estática do .env
        const LOOPBACK_BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
        const PUBLIC_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

        try { browser = await getBrowser(); page = await browser.newPage(); }
        catch (e) {
          const msg = String(e?.message || '');
          if (!triedRestart && /Target closed|Browser is closed|WebSocket is not open|TargetCloseError/i.test(msg)) {
            triedRestart = true;
            try { await browser?.close().catch(()=>{}); } catch(_){}
            _browserPromise = null; browser = await getBrowser(); page = await browser.newPage();
          } else { throw e; }
        }

        await page.setCacheEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (reqObj) => {
          const u = reqObj.url();
          if (u === 'about:blank' || u.startsWith('data:')) return reqObj.continue();
          const allowed =
            (u.startsWith(LOOPBACK_BASE)) ||
            (PUBLIC_BASE && u.startsWith(PUBLIC_BASE));
          return allowed ? reqObj.continue() : reqObj.abort();
        });

        page.setDefaultNavigationTimeout(90_000);
        page.setDefaultTimeout(90_000);
        await page.emulateMediaType('screen');

        // 1) Carrega a página SEM querystring
         const CANDIDATES = [
           'form_gera_termo_solic_crp_2.html',
           'form_gera_termo_solic_crp.html',
           'termo_solic_crp.html',
           'solic_crp.html'
         ];
         const urlsToTry = [
           ...CANDIDATES.map(n => `${LOOPBACK_BASE}/${n}`),
           ...(PUBLIC_BASE ? CANDIDATES.map(n => `${PUBLIC_BASE}/${n}`) : [])
         ];

        let loaded = false; let lastErr = null;
        for (const u of urlsToTry) {
          try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 90_000 }); loaded = true; break; }
          catch (e) { lastErr = e; }
        }
        if (!loaded) throw lastErr || new Error('Falha ao carregar termo_solic_crp.html');

        // 2) Injeta os dados na página
        const payloadForClient = {
          ...p,
          CRITERIOS_IRREGULARES: Array.isArray(p.CRITERIOS_IRREGULARES)
            ? p.CRITERIOS_IRREGULARES
            : String(p.CRITERIOS_IRREGULARES || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
        };

        await page.evaluate((payload) => {
          window.__TERMO_DATA__ = payload;
          document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
        }, payloadForClient);

        // 3) Aguarda sinalização de pronto para impressão
        await page.waitForSelector('#pdf-root', { timeout: 20_000 }).catch(()=>{});
        await page.evaluate(() => new Promise((ok) => {
          if (window.__TERMO_PRINT_READY__ === true) return ok();
          document.addEventListener('TERMO_PRINT_READY', () => ok(), { once: true });
          setTimeout(ok, 1500);
        }));

        // 4) Embute fontes iguais ao outro termo
        function findFont(candidates){
          const path = require('path'); const fs = require('fs');
          for (const rel of candidates){
            const abs = path.join(__dirname, '../frontend', rel.replace(/^\/+/, ''));
            if (fs.existsSync(abs)) return (function inlineFont(relPath) {
              try{
                const pth = path.join(__dirname, '../frontend', relPath.replace(/^\/+/, ''));
                const buf = fs.readFileSync(pth);
                const b64 = buf.toString('base64');
                const ext = require('path').extname(pth).toLowerCase();
                const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : 'application/octet-stream';
                const fmt  = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : 'truetype';
                return `url(data:${mime};base64,${b64}) format('${fmt}')`;
              }catch{ return null; }
            })(rel);
          }
          return null;
        }
        const rawline400 = findFont(['fonts/rawline-regular.woff2','fonts/rawline-regular.woff','fonts/rawline-regular.ttf']);
        const rawline700 = findFont(['fonts/rawline-bold.woff2','fonts/rawline-bold.woff','fonts/rawline-bold.ttf']);
        let fontCSS = '';
        if (rawline400) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:400;src:${rawline400};font-display:swap;}`;
        if (rawline700) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:700;src:${rawline700};font-display:swap;}`;
        fontCSS += `body{font-family:'Rawline', Inter, Arial, sans-serif;}`;

        await page.addStyleTag({ content: `
          ${fontCSS}
          html, body, #pdf-root { background:#ffffff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .page-head .logos-wrap { display: none !important; }
          .term-wrap { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
          .term-title { margin-top: 2mm !important; }
        `});

        // 5) Header/footer (mesmo padrão visual do /api/termo-pdf)
        const path = require('path'); const fs = require('fs');
        function inlineSvg(relPath) {
          try {
            const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/,''));
            const raw = fs.readFileSync(abs, 'utf8');
            return raw.replace(/<\?xml[^>]*>/g, '').replace(/<!DOCTYPE[^>]*>/g, '')
              .replace(/\r?\n|\t/g, ' ').replace(/>\s+</g, '><').trim();
          } catch { return ''; }
        }
        const svgSec = inlineSvg('imagens/logo-secretaria-complementar.svg');
        const svgMps = inlineSvg('imagens/logo-termo-drpps.svg');
        const headerTemplate = `
          <style>
            .pdf-header { font-family: Inter, Arial, sans-serif; width: 100%; padding: 6mm 12mm 4mm; }
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
          </div>`;
        const footerTemplate = `<div></div>`;

        // 6) Gera o PDF
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: true,
          headerTemplate,
          footerTemplate,
          margin: { top: '38mm', right: '0mm', bottom: '12mm', left: '0mm' }
        });
        await page.close();

        const filenameSafe = (p.ENTE || 'termo-solic-crp')
          .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'').toLowerCase();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="termo-solic-${filenameSafe}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.send(pdf);
      } catch (e) {
        console.error('❌ /api/termo-solic-crp-pdf:', e);
        try { if (page) await page.close(); } catch(_) {}
        res.status(500).json({ error: 'Falha ao gerar PDF' });
      }
    });
  } catch (e) {
    console.error('❌ (outer) /api/termo-solic-crp-pdf:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar PDF' });
  }
});


/** POST /api/solic-crp-pdf — gera PDF da solicitação CRP */
app.post('/api/solic-crp-pdf', async (req, res) => {
  try {
    const p = validateOr400(res, schemaSolicCrpPdf, req.body || {});
    if (!p) return;

    await withPdfLimiter(async () => {
      let page; let browser; let triedRestart = false;
      try {
        // base loopback (mesma proteção do /api/termo-pdf)
        const LOOPBACK_BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
        const PUBLIC_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

        try { browser = await getBrowser(); page = await browser.newPage(); }
        catch (e) {
          const msg = String(e?.message || '');
          if (!triedRestart && /Target closed|Browser is closed|WebSocket is not open|TargetCloseError/i.test(msg)) {
            triedRestart = true;
            try { await browser?.close().catch(()=>{}); } catch(_){}
            _browserPromise = null; browser = await getBrowser(); page = await browser.newPage();
          } else { throw e; }
        }

        await page.setCacheEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (reqObj) => {
          const u = reqObj.url();
          if (u === 'about:blank' || u.startsWith('data:')) return reqObj.continue();
          const allowed =
            (u.startsWith(LOOPBACK_BASE)) ||
            (PUBLIC_BASE && u.startsWith(PUBLIC_BASE));
          return allowed ? reqObj.continue() : reqObj.abort();
        });

        page.setDefaultNavigationTimeout(90_000);
        page.setDefaultTimeout(90_000);
        await page.emulateMediaType('screen');

        // 1) Carrega a página SEM querystring para evitar PII em logs
        const CANDIDATES = [
          'solic_crp.html',
          'termo_solic_crp.html',
          'form_gera_termo_solic_crp_2.html',
          'form_gera_termo_solic_crp.html'
        ];
        const urlsToTry = [
          ...CANDIDATES.map(n => `${LOOPBACK_BASE}/${n}`),
          ...(PUBLIC_BASE ? CANDIDATES.map(n => `${PUBLIC_BASE}/${n}`) : [])
        ];

        let loaded = false; let lastErr = null;
        for (const u of urlsToTry) {
          try {
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 90_000 });
            loaded = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!loaded) throw lastErr || new Error('Falha ao carregar solic_crp.html');

        // 2) Injeta os dados esperados pelo front
        const payloadForClient = {
          ...p,
          CRITERIOS_IRREGULARES: Array.isArray(p.CRITERIOS_IRREGULARES)
            ? p.CRITERIOS_IRREGULARES
            : String(p.CRITERIOS_IRREGULARES || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
        };

        await page.evaluate((payload) => {
          window.__TERMO_DATA__ = payload;
          document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
        }, payloadForClient);

        // 3) Sinalização de pronto para impressão
        await page.waitForSelector('#pdf-root', { timeout: 20_000 }).catch(() => {});
        await page.evaluate(() => new Promise((ok) => {
          if (window.__TERMO_PRINT_READY__ === true) return ok();
          document.addEventListener('TERMO_PRINT_READY', () => ok(), { once: true });
          setTimeout(ok, 1500);
        }));

        // 4) Embute fontes (mesma família dos outros PDFs)
        function findFont(candidates){
          const path = require('path'); const fs = require('fs');
          for (const rel of candidates){
            const abs = path.join(__dirname, '../frontend', rel.replace(/^\/+/, ''));
            if (fs.existsSync(abs)) {
              try{
                const buf = fs.readFileSync(abs);
                const b64 = buf.toString('base64');
                const ext = path.extname(abs).toLowerCase();
                const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : 'application/octet-stream';
                const fmt  = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : 'truetype';
                return `url(data:${mime};base64,${b64}) format('${fmt}')`;
              }catch{ return null; }
            }
          }
          return null;
        }
        const rawline400 = findFont(['fonts/rawline-regular.woff2','fonts/rawline-regular.woff','fonts/rawline-regular.ttf']);
        const rawline700 = findFont(['fonts/rawline-bold.woff2','fonts/rawline-bold.woff','fonts/rawline-bold.ttf']);
        let fontCSS = '';
        if (rawline400) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:400;src:${rawline400};font-display:swap;}`;
        if (rawline700) fontCSS += `@font-face{font-family:'Rawline';font-style:normal;font-weight:700;src:${rawline700};font-display:swap;}`;
        fontCSS += `body{font-family:'Rawline', Inter, Arial, sans-serif;}`;

        await page.addStyleTag({ content: `
          ${fontCSS}
          html, body, #pdf-root { background:#ffffff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .page-head .logos-wrap { display: none !important; }
          .term-wrap { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
          .term-title { margin-top: 2mm !important; }
        `});

        // 5) Header/footer com logos
        const path = require('path'); const fs = require('fs');
        function inlineSvg(relPath) {
          try {
            const abs = path.join(__dirname, '../frontend', relPath.replace(/^\/+/,''));
            const raw = fs.readFileSync(abs, 'utf8');
            return raw.replace(/<\?xml[^>]*>/g, '').replace(/<!DOCTYPE[^>]*>/g, '')
              .replace(/\r?\n|\t/g, ' ').replace(/>\s+</g, '><').trim();
          } catch { return ''; }
        }
        const svgSec = inlineSvg('imagens/logo-secretaria-complementar.svg');
        const svgMps = inlineSvg('imagens/logo-termo-drpps.svg');
        const headerTemplate = `
          <style>
            .pdf-header { font-family: Inter, Arial, sans-serif; width: 100%; padding: 6mm 12mm 4mm; }
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
          </div>`;
        const footerTemplate = `<div></div>`;

        // 6) Gera PDF
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: true,
          headerTemplate,
          footerTemplate,
          margin: { top: '38mm', right: '0mm', bottom: '12mm', left: '0mm' }
        });
        await page.close();

        const filenameSafe = (p.ENTE || 'solic-crp')
          .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'').toLowerCase();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="solic-crp-${filenameSafe}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.send(pdf);
      } catch (e) {
        console.error('❌ /api/solic-crp-pdf:', e);
        try { if (page) await page.close(); } catch(_) {}
        res.status(500).json({ error: 'Falha ao gerar PDF' });
      }
    });
  } catch (e) {
    console.error('❌ (outer) /api/solic-crp-pdf:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar PDF' });
  }
});


/* ========= Boot ========= */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  if (LOG_LEVEL !== 'silent') {
    console.log(`🚀 RPPS API ouvindo em http://${HOST}:${PORT}`);
    if (REQUIRE_API_KEY) console.log('🔐 API Key exigida (REQUIRE_API_KEY=1)');
    console.log(`🛡  trust proxy = ${JSON.stringify(TRUST_PROXY)}`);
  }
});

// opcional: encerra graciosamente
function shutdown(sig) {
  if (LOG_LEVEL !== 'silent') console.log(`\n${sig} recebido. Encerrando...`);
  try { server.close(() => process.exit(0)); }
  catch { process.exit(0); }
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
