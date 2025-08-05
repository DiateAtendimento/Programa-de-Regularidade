// backend/server.js
require('dotenv').config();

const fs             = require('fs');
const path           = require('path');
const express        = require('express');
const cors           = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());
// serve arquivos estáticos do frontend
app.use('/', express.static(path.join(__dirname, '../frontend')));

// — Preparações iniciais
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

// — Google Sheets
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// Rota que grava no Sheets
app.post('/api/gerar-termo', async (req, res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao gravar no Sheets:', err);
    res.status(500).json({ error: 'Falha ao gravar no Sheets.' });
  }
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
