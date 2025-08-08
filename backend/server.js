require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(helmet.contentSecurityPolicy({ useDefaults:true }));
app.use(rateLimit({ windowMs:15*60*1000, max:100 }));
app.use(hpp());

const allowedOrigins = [
  process.env.CORS_ORIGIN,
  'https://programa-de-regularidade.netlify.app'
];
app.use(cors({
  origin: (origin, cb) => !origin||allowedOrigins.includes(origin)? cb(null,true): cb(new Error('CORS')),
  methods: ['GET','POST']
}));

app.use(express.json({ limit:'10kb' }));
app.use('/', express.static(path.join(__dirname,'../frontend')));
app.use('/animacao', express.static(path.join(__dirname,'../frontend/animacao')));

const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error('❌ credentials.json não encontrado'); process.exit(1);
}
const creds = require(credsPath);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets(){ await doc.useServiceAccountAuth(creds); await doc.loadInfo(); }

// grava dados do formulário
app.post('/api/gerar-termo', async (req,res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByTitle['Dados'];
    const now = new Date();
    const timestampDate = now.toLocaleDateString('pt-BR');
    const timestampTime = now.toLocaleTimeString('pt-BR',{hour12:false, timeZone:'America/Sao_Paulo'});
    const row = { ...req.body, DATA:timestampDate, HORA:timestampTime };
    await sheet.addRow(row);
    res.json({ ok:true });
  } catch(err) {
    console.error('❌ Falha ao gravar:', err);
    res.status(500).json({ error:'Failed to write to Google Sheets.' });
  }
});

// fornece lista de entes
app.get('/api/entes', async (req,res) => {
  try {
    await authSheets();
    const fonte = doc.sheetsByTitle['Fonte'];
    const rows = await fonte.getRows();
    const entes = rows.map(r=>({ uf:r.UF.trim(), ente:r.ENTE.trim() }));
    res.json(entes);
  } catch(err) {
    console.error('❌ Falha ao obter entes:', err);
    res.status(500).json({ error:'Erro interno.' });
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=> console.log(`🚀 Server rodando na porta ${PORT}`));
