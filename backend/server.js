// server.js — API RPPS (multi-etapas): CNPJ_ENTE_UG, Dados_REP_ENTE_UG, CRP (colunas fixas B/F/G),
// gravação em Termos_registrados e log em Reg_alteracao_dados_ente_ug

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();

/* ───────────────── Segurança ──────────────── */
app.set('trust proxy', 1);               // evita ERR_ERL_UNEXPECTED_X_FORWARDED_FOR atrás de proxy
app.disable('x-powered-by');

// util: lista de origens sem barra final
const splitList = (s = '') => s.split(/[\s,]+/).map(v => v.trim().replace(/\/+$/, '')).filter(Boolean);
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
    styleSrc:   ["'self'","https://cdn.jsdelivr.net","https://fonts.googleapis.com","'unsafe-inline'"],
    fontSrc:    ["'self'","https://fonts.gstatic.com"],
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

/* ───────────────── CORS ───────────────── */
const allowed = [
  ...(splitList(process.env.CORS_ORIGIN_LIST || '')),
  ...(splitList(process.env.CORS_ORIGIN || ''))
].filter(Boolean);

console.log('🔐 CORS liberado para:', JSON.stringify(allowed, null, 2));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/+$/, '');
    const ok = allowed.length ? allowed.includes(o) : true;
    return ok ? cb(null, true) : cb(new Error(`Origin não autorizada: ${origin}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

/* ─────────────── Static ─────────────── */
app.use('/', express.static(path.join(__dirname, '../frontend')));

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

async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

const norm   = v => (v ?? '').toString().trim();
const low    = v => norm(v).toLowerCase();
const digits = v => norm(v).replace(/\D+/g,'');

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

async function getSheet(title){
  const s = doc.sheetsByTitle[title];
  if(!s) throw new Error(`Aba '${title}' não encontrada.`);
  return s;
}

function esferaFromEnte(ente){
  return low(ente).includes('governo do estado') ? 'Estadual/Distrital' : 'RPPS Municipal';
}

/* ───── Helpers (headers duplicados) ───── */
async function getRowsViaCells(sheet) {
  await sheet.loadHeaderRow();
  const headers = (sheet.headerValues || []).map(h => norm(h));

  const seen = {};
  const headersUnique = headers.map(h => {
    if (!h) return '';
    seen[h] = (seen[h] || 0) + 1;
    return seen[h] === 1 ? h : `${h}__${seen[h]}`;
  });

  const cols = headersUnique.length || sheet.columnCount || 26;
  const endRow = sheet.rowCount || 2000;

  await sheet.loadCells({ startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: cols });

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

function getVal(row, ...candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const k = keys.find(k =>
      low(k) === low(cand) || low(k).startsWith(low(cand) + '__')
    );
    if (k) return row[k];
  }
  return undefined;
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

/* ───── Leitura CRP (colunas fixas B/F/G = 1/5/6) ───── */
async function readCRPByFixedColumns(sheet) {
  const colCNPJ = 1, colVal = 5, colDec = 6; // 0-based
  const endRow = sheet.rowCount || 2000;
  const endCol = Math.max(colCNPJ, colVal, colDec) + 1;

  await sheet.loadCells({ startRowIndex: 1, startColumnIndex: 0, endRowIndex: endRow, endColumnIndex: endCol });

  const rows = [];
  for (let r = 1; r < endRow; r++) {
    const cnpjCell = sheet.getCell(r, colCNPJ);
    const valCell  = sheet.getCell(r, colVal);
    const decCell  = sheet.getCell(r, colDec);

    const cnpj = digits(cnpjCell?.value ?? '');

    // normaliza validade
    let validadeDMY = '';
    const fv = valCell?.formattedValue;
    if (fv && /^\d{2}\/\d{2}\/\d{4}$/.test(String(fv))) {
      validadeDMY = String(fv);
    } else if (valCell?.value instanceof Date) {
      validadeDMY = formatDateDMY(valCell.value);
    } else if (typeof valCell?.value === 'number') { // serial -> Date
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + valCell.value * 86400000);
      validadeDMY = formatDateDMY(d);
    } else if (typeof valCell?.value === 'string') {
      validadeDMY = valCell.value;
    }
    const validadeISO = formatDateISO(parseDMYorYMD(validadeDMY));

    const decisao  = norm(decCell?.formattedValue ?? decCell?.value ?? '');

    if (!cnpj && !validadeDMY && !decisao) continue;
    rows.push({
      CNPJ_ENTE: cnpj,
      DATA_VALIDADE_DMY: validadeDMY,
      DATA_VALIDADE_ISO: validadeISO,
      DECISAO_JUDICIAL: decisao
    });
  }
  return rows;
}

/* ─────────────── ROTAS ─────────────── */

/** GET /api/consulta?cnpj=NNNNNNNNNNNNNN */
app.get('/api/consulta', async (req, res) => {
  try {
    const cnpj = digits(req.query.cnpj || '');
    if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });

    await authSheets();

    const sCnpj = await getSheet('CNPJ_ENTE_UG');
    const sReps = await getSheet('Dados_REP_ENTE_UG');
    const sCrp  = await getSheet('CRP');

    const cnpjRows = await getRowsSafe(sCnpj);
    let base = cnpjRows.find(r => digits(getVal(r,'CNPJ_ENTE')) === cnpj);
    if (!base) base = cnpjRows.find(r => digits(getVal(r,'CNPJ_UG')) === cnpj);
    if (!base) return res.status(404).json({ error: 'CNPJ não encontrado em CNPJ_ENTE_UG.' });

    const UF        = norm(getVal(base, 'UF'));
    const ENTE      = norm(getVal(base, 'ENTE'));
    const UG        = norm(getVal(base, 'UG'));
    const CNPJ_ENTE = digits(getVal(base, 'CNPJ_ENTE'));
    const CNPJ_UG   = digits(getVal(base, 'CNPJ_UG'));

    // Reps para snapshot
    const repsAll = await getRowsSafe(sReps);
    const reps = repsAll.filter(r => low(getVal(r,'UF')) === low(UF) && low(getVal(r,'ENTE')) === low(ENTE));
    const repUG = reps.find(r => low(getVal(r,'UG')) === low(UG)) || reps[0] || {};
    const repEnte =
      reps.find(r => ['','ente','adm direta','administração direta','administracao direta'].includes(low(getVal(r,'UG')||''))) ||
      reps.find(r => low(getVal(r,'UG')||'') !== low(UG)) || reps[0] || {};

    // CRP (B/F/G)
    const crpAll = await readCRPByFixedColumns(sCrp);
    const crpCandidates = crpAll.filter(r => digits(r.CNPJ_ENTE) === CNPJ_ENTE);
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
      CRP_DATA_VALIDADE: crp.DATA_VALIDADE_ISO,           // yyyy-mm-dd para <input type="date">
      CRP_DATA_VALIDADE_BR: crp.DATA_VALIDADE_DMY,        // dd/mm/aaaa (se precisar exibir)
      CRP_DECISAO_JUDICIAL: crp.DECISAO_JUDICIAL,
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
        CRP_VALIDADE:  crp.DATA_VALIDADE_DMY
      }
    };

    return res.json({ ok:true, data: out });
  } catch (err) {
    console.error('❌ /api/consulta:', err);
    res.status(500).json({ error:'Falha interna.' });
  }
});

/** GET /api/rep-by-cpf?cpf=NNNNNNNNNNN */
app.get('/api/rep-by-cpf', async (req,res)=>{
  try{
    const cpf = digits(req.query.cpf || '');
    if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido.' });

    await authSheets();
    const sReps = await getSheet('Dados_REP_ENTE_UG');
    const rows = await getRowsSafe(sReps);
    const found = rows.find(r => digits(getVal(r,'CPF')) === cpf);
    if(!found) return res.status(404).json({ error:'CPF não encontrado.' });

    return res.json({
      ok:true,
      data:{
        UF: norm(getVal(found,'UF')),
        ENTE: norm(getVal(found,'ENTE')),
        UG: norm(getVal(found,'UG')),
        NOME: norm(getVal(found,'NOME')),
        CPF: digits(getVal(found,'CPF')),
        EMAIL: norm(getVal(found,'EMAIL')),
        TELEFONE: norm(getVal(found,'TELEFONE_MOVEL') || getVal(found,'TELEFONE')),
        CARGO: norm(getVal(found,'CARGO')),
      }
    });
  }catch(err){
    console.error('❌ /api/rep-by-cpf:', err);
    res.status(500).json({ error:'Falha interna.' });
  }
});

/** POST /api/gerar-termo */
app.post('/api/gerar-termo', async (req,res)=>{
  try{
    const p = req.body || {};
    const must = [
      'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
      'NOME_REP_ENTE','CPF_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE',
      'NOME_REP_UG','CPF_REP_UG','CARGO_REP_UG','EMAIL_REP_UG',
      'DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP'
    ];
    for(const k of must){
      if(!norm(p[k])) return res.status(400).json({ error:`Campo obrigatório ausente: ${k}` });
    }

    await authSheets();
    const sTermos = await getSheet('Termos_registrados');
    const sLog    = await getSheet('Reg_alteracao_dados_ente_ug');

    const { DATA, HORA, ANO, MES } = nowBR();
    const criterios = Array.isArray(p.CRITERIOS_IRREGULARES)
      ? p.CRITERIOS_IRREGULARES
      : String(p.CRITERIOS_IRREGULARES || '').split(',').map(s=>s.trim()).filter(Boolean);

    await sTermos.addRow({
      ENTE: norm(p.ENTE),
      UF: norm(p.UF),
      CNPJ_ENTE: digits(p.CNPJ_ENTE),
      EMAIL_ENTE: norm(p.EMAIL_ENTE),
      NOME_REP_ENTE: norm(p.NOME_REP_ENTE),
      CARGO_REP_ENTE: norm(p.CARGO_REP_ENTE),
      CPF_REP_ENTE: digits(p.CPF_REP_ENTE),
      EMAIL_REP_ENTE: norm(p.EMAIL_REP_ENTE),
      UG: norm(p.UG),
      CNPJ_UG: digits(p.CNPJ_UG),
      EMAIL_UG: norm(p.EMAIL_UG),
      NOME_REP_UG: norm(p.NOME_REP_UG),
      CARGO_REP_UG: norm(p.CARGO_REP_UG),
      CPF_REP_UG: digits(p.CPF_REP_UG),
      EMAIL_REP_UG: norm(p.EMAIL_REP_UG),
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
      MES, DATA_TERMO_GERADO: DATA, HORA_TERMO_GERADO: HORA, ANO_TERMO_GERADO: ANO
    });

    // Log de alterações com base no snapshot enviado
    const snap = p.__snapshot_base || {};
    const compareCols = [
      'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
      'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
      'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG'
    ];
    const changed = [];
    for (const col of compareCols) {
      const a = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL')) ? digits(snap[col] || '') : norm(snap[col] || '');
      const b = (col.includes('CPF') || col.includes('CNPJ') || col.includes('TEL')) ? digits(p[col] || '')   : norm(p[col] || '');
      if (low(a) !== low(b)) changed.push(col);
    }
    if (changed.length) {
      const t = nowBR();
      await sLog.addRow({
        UF: norm(p.UF),
        ENTE: norm(p.ENTE),
        'CAMPOS ALTERADOS': changed.join(', '),
        'QTD_CAMPOS_ALTERADOS': changed.length,
        MES: t.MES, DATA: t.DATA, HORA: t.HORA
      });
    }

    return res.json({ ok:true });
  } catch (err) {
    console.error('❌ /api/gerar-termo:', err);
    res.status(500).json({ error:'Falha ao registrar o termo.' });
  }
});

/* ─────────────── Start ─────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
