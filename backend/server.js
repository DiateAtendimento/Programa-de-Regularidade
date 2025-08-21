// server.js — API RPPS (multi-etapas)
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

/* ───────── Segurança ───────── */
app.disable('x-powered-by');

// helper: quebra em lista (vírgula ou espaço) e remove barra final
const splitList = (s='') => s.split(/[,\s]+/).map(v=>v.trim().replace(/\/+$/,'')).filter(Boolean);

// >>> une CORS_ORIGIN e CORS_ORIGIN_LIST
const originList = splitList(
  [process.env.CORS_ORIGIN, process.env.CORS_ORIGIN_LIST].filter(Boolean).join(' ')
);
const connectExtra = originList.slice();

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

app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(hpp());
app.use(express.json({ limit: '200kb' }));

/* ───────── CORS ───────── */
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin
    const o = origin.replace(/\/+$/,'');
    const ok = originList.length ? originList.includes(o) : true;
    if (ok) return cb(null, true);
    return cb(new Error(`Origin não autorizada: ${origin}. Permitidas: ${originList.join(', ') || 'todas'}`));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));
console.log('🔐 CORS liberado para:', originList.length ? originList : '(todas as origens)');

/* ───────── Static ───────── */
app.use('/', express.static(path.join(__dirname, '../frontend')));

/* ───────── Google Sheets ───────── */
const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) { console.error('❌ Defina SHEET_ID no .env'); process.exit(1); }

let creds;
if (process.env.GOOGLE_CREDENTIALS_B64) {
  try { creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64,'base64').toString('utf8')); }
  catch { console.error('❌ GOOGLE_CREDENTIALS_B64 inválido.'); process.exit(1); }
} else {
  const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH || 'credentials.json');
  if (!fs.existsSync(credsPath)) { console.error(`❌ credentials.json não encontrado em ${credsPath}`); process.exit(1); }
  creds = require(credsPath);
}

const doc = new GoogleSpreadsheet(SHEET_ID);
async function authSheets(){ await doc.useServiceAccountAuth(creds); await doc.loadInfo(); }
const norm = v => (v ?? '').toString().trim();
const low  = v => norm(v).toLowerCase();
const digits = v => norm(v).replace(/\D+/g,'');

function nowBR(){
  const tz='America/Sao_Paulo', d=new Date();
  return {
    DATA: d.toLocaleDateString('pt-BR',{timeZone:tz}),
    HORA: d.toLocaleTimeString('pt-BR',{hour12:false,timeZone:tz}),
    ANO: d.getFullYear(),
    MES: String(d.getMonth()+1).padStart(2,'0'),
  };
}
async function getSheet(title){ const s = doc.sheetsByTitle[title]; if(!s) throw new Error(`Aba '${title}' não encontrada.`); return s; }
function esferaFromEnte(ente){ return low(ente).includes('governo do estado') ? 'Estadual/Distrital' : 'RPPS Municipal'; }

function findHeader(headers, ...contains){
  const hnorm = headers.map(h=>({raw:h, n: low(h)}));
  for(const h of hnorm){ if(contains.every(c=>h.n.includes(c))) return h.raw; }
  return null;
}
function parseDateYMDorDMY(s){
  const v = norm(s); if(!v) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v+'T00:00:00');
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  const d = new Date(v); return isNaN(d)?null:d;
}

/* ───────── ROTAS ───────── */

// GET /api/consulta?cnpj=...
app.get('/api/consulta', async (req,res)=>{
  try{
    const cnpj = digits(req.query.cnpj||'');
    if(cnpj.length!==14) return res.status(400).json({error:'CNPJ inválido.'});

    await authSheets();
    const sCnpj = await getSheet('CNPJ_ENTE_UG');
    const sReps = await getSheet('Dados_REP_ENTE_UG');
    const sCrp  = await getSheet('CRP');

    const cnpjRows = await sCnpj.getRows();
    const base = cnpjRows.find(r => digits(r.CNPJ_ENTE)===cnpj);
    if(!base) return res.status(404).json({error:'CNPJ não encontrado em CNPJ_ENTE_UG.'});

    const UF = norm(base.UF), ENTE = norm(base.ENTE), UG = norm(base.UG);
    const CNPJ_ENTE = digits(base.CNPJ_ENTE), CNPJ_UG = digits(base.CNPJ_UG);

    const repRows = (await sReps.getRows()).filter(r => low(r.UF)===low(UF) && low(r.ENTE)===low(ENTE));
    const repUG   = repRows.find(r => low(r.UG)===low(UG)) || repRows[0] || {};
    const repEnte = repRows.find(r => ['','ente','adm direta','administração direta','administracao direta'].includes(low(r.UG)))
                  || repRows.find(r => low(r.UG)!==low(UG)) || repRows[0] || {};

    const crpRows = (await sCrp.getRows()).filter(r => digits(r.CNPJ_ENTE)===CNPJ_ENTE);
    let crp={};
    if(crpRows.length){
      const headerVals = sCrp.headerValues || [];
      const djHeader = findHeader(headerVals,'deci','judi') || headerVals.find(h=>low(h).includes('judicial')) || null;
      crpRows.sort((a,b)=>{
        const da = parseDateYMDorDMY(a.DATA_VALIDADE) || new Date(0);
        const db = parseDateYMDorDMY(b.DATA_VALIDADE) || new Date(0);
        return db-da;
      });
      const top = crpRows[0];
      crp = { DATA_VALIDADE: norm(top.DATA_VALIDADE||''), DECISAO_JUDICIAL: djHeader ? norm(top[djHeader]) : '' };
      const m = crp.DATA_VALIDADE.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if(m) crp.DATA_VALIDADE = `${m[3]}-${m[2]}-${m[1]}`;
    }

    const out = {
      UF, ENTE, CNPJ_ENTE, UG, CNPJ_UG,
      NOME_REP_ENTE: norm(repEnte.NOME), CPF_REP_ENTE: digits(repEnte.CPF),
      EMAIL_REP_ENTE: norm(repEnte.EMAIL), TEL_REP_ENTE: norm(repEnte.TELEFONE_MOVEL || repEnte.TELEFONE), CARGO_REP_ENTE: norm(repEnte.CARGO),
      NOME_REP_UG: norm(repUG.NOME), CPF_REP_UG: digits(repUG.CPF),
      EMAIL_REP_UG: norm(repUG.EMAIL), TEL_REP_UG: norm(repUG.TELEFONE_MOVEL || repUG.TELEFONE), CARGO_REP_UG: norm(repUG.CARGO),
      CRP_DATA_VALIDADE: norm(crp.DATA_VALIDADE||''), CRP_DECISAO_JUDICIAL: norm(crp.DECISAO_JUDICIAL||''),
      ESFERA_SUGERIDA: esferaFromEnte(ENTE),
      __snapshot: {
        UF, ENTE, CNPJ_ENTE, UG, CNPJ_UG,
        NOME_REP_ENTE: norm(repEnte.NOME), CPF_REP_ENTE: digits(repEnte.CPF),
        TEL_REP_ENTE: norm(repEnte.TELEFONE_MOVEL || repEnte.TELEFONE), EMAIL_REP_ENTE: norm(repEnte.EMAIL), CARGO_REP_ENTE: norm(repEnte.CARGO),
        NOME_REP_UG: norm(repUG.NOME), CPF_REP_UG: digits(repUG.CPF),
        TEL_REP_UG: norm(repUG.TELEFONE_MOVEL || repUG.TELEFONE), EMAIL_REP_UG: norm(repUG.EMAIL), CARGO_REP_UG: norm(repUG.CARGO),
        CRP: norm(crp.DECISAO_JUDICIAL||''), CRP_VALIDADE: norm(crp.DATA_VALIDADE||'')
      }
    };

    return res.json({ ok:true, data: out });
  }catch(err){
    console.error('❌ /api/consulta:', err);
    res.status(500).json({error:'Falha interna.'});
  }
});

// GET /api/rep-by-cpf?cpf=...
app.get('/api/rep-by-cpf', async (req,res)=>{
  try{
    const cpf = digits(req.query.cpf||'');
    if(cpf.length!==11) return res.status(400).json({error:'CPF inválido.'});
    await authSheets();
    const sReps = await getSheet('Dados_REP_ENTE_UG');
    const rows = await sReps.getRows();
    const found = rows.find(r => digits(r.CPF)===cpf);
    if(!found) return res.status(404).json({error:'CPF não encontrado.'});
    return res.json({ ok:true, data:{
      UF:norm(found.UF), ENTE:norm(found.ENTE), UG:norm(found.UG),
      NOME:norm(found.NOME), CPF:digits(found.CPF),
      EMAIL:norm(found.EMAIL), TELEFONE:norm(found.TELEFONE_MOVEL || found.TELEFONE),
      CARGO:norm(found.CARGO)
    }});
  }catch(err){
    console.error('❌ /api/rep-by-cpf:', err);
    res.status(500).json({error:'Falha interna.'});
  }
});

// POST /api/gerar-termo
app.post('/api/gerar-termo', async (req,res)=>{
  try{
    const p = req.body||{};
    const must = ['UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG','NOME_REP_ENTE','CPF_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','NOME_REP_UG','CPF_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','DATA_VENCIMENTO_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP'];
    for(const k of must){ if(!norm(p[k])) return res.status(400).json({error:`Campo obrigatório ausente: ${k}`}); }

    await authSheets();
    const sTermos = await getSheet('Termos_registrados');
    const sLog    = await getSheet('Reg_alteracao_dados_ente_ug');

    const { DATA,HORA,ANO,MES } = nowBR();
    const criterios = Array.isArray(p.CRITERIOS_IRREGULARES) ? p.CRITERIOS_IRREGULARES
      : String(p.CRITERIOS_IRREGULARES||'').split(',').map(s=>s.trim()).filter(Boolean);

    await sTermos.addRow({
      ENTE:norm(p.ENTE), UF:norm(p.UF),
      CNPJ_ENTE:digits(p.CNPJ_ENTE), EMAIL_ENTE:norm(p.EMAIL_ENTE),
      NOME_REP_ENTE:norm(p.NOME_REP_ENTE), CARGO_REP_ENTE:norm(p.CARGO_REP_ENTE),
      CPF_REP_ENTE:digits(p.CPF_REP_ENTE), EMAIL_REP_ENTE:norm(p.EMAIL_REP_ENTE),
      UG:norm(p.UG), CNPJ_UG:digits(p.CNPJ_UG), EMAIL_UG:norm(p.EMAIL_UG),
      NOME_REP_UG:norm(p.NOME_REP_UG), CARGO_REP_UG:norm(p.CARGO_REP_UG),
      CPF_REP_UG:digits(p.CPF_REP_UG), EMAIL_REP_UG:norm(p.EMAIL_REP_UG),
      DATA_VENCIMENTO_ULTIMO_CRP:norm(p.DATA_VENCIMENTO_ULTIMO_CRP),
      TIPO_EMISSAO_ULTIMO_CRP:norm(p.TIPO_EMISSAO_ULTIMO_CRP),
      CRITERIOS_IRREGULARES:criterios.join(', '),
      CELEBRACAO_TERMO_PARCELA_DEBITOS:norm(p.CELEBRACAO_TERMO_PARCELA_DEBITOS),
      REGULARIZACAO_PENDEN_ADMINISTRATIVA:norm(p.REGULARIZACAO_PENDEN_ADMINISTRATIVA),
      DEFICIT_ATUARIAL:norm(p.DEFICIT_ATUARIAL),
      CRITERIOS_ESTRUT_ESTABELECIDOS:norm(p.CRITERIOS_ESTRUT_ESTABELECIDOS),
      MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS:norm(p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS),
      COMPROMISSO_FIRMADO_ADESAO:norm(p.COMPROMISSO_FIRMADO_ADESAO),
      PROVIDENCIA_NECESS_ADESAO:norm(p.PROVIDENCIA_NECESS_ADESAO),
      CONDICAO_VIGENCIA:norm(p.CONDICAO_VIGENCIA),
      MES, DATA_TERMO_GERADO:DATA, HORA_TERMO_GERADO:HORA, ANO_TERMO_GERADO:ANO
    });

    const snap = p.__snapshot_base || {};
    const compareCols = ['UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG','NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE','NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG'];
    const changed=[];
    for(const col of compareCols){
      const a = (col.includes('CPF')||col.includes('CNPJ')) ? digits(snap[col]||'') : norm(snap[col]||'');
      const b = (col.includes('CPF')||col.includes('CNPJ')) ? digits(p[col]||'')   : norm(p[col]||'');
      if(low(a)!==low(b)) changed.push(col);
    }
    if(changed.length){
      const { DATA:dlog, HORA:hlog, MES:mlog } = nowBR();
      await sLog.addRow({ UF:norm(p.UF), ENTE:norm(p.ENTE), 'CAMPOS ALTERADOS':changed.join(', '), 'QTD_CAMPOS_ALTERADOS':changed.length, MES:mlog, DATA:dlog, HORA:hlog });
    }

    return res.json({ok:true});
  }catch(err){
    console.error('❌ /api/gerar-termo:', err);
    res.status(500).json({error:'Falha ao registrar o termo.'});
  }
});

/* ───────── Start ───────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`🚀 Server rodando na porta ${PORT}`));
