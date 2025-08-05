//server.js
require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors    = require('cors');
const PizZip  = require('pizzip');
const Docxtemplater = require('docxtemplater');
// usar v3.x: npm install google-spreadsheet@3.3.0
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/', express.static(path.join(__dirname, '../frontend')));

// Preparações iniciais
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

const tmpDir = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Configuração do Google Sheets
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// Rota principal: gera termo e PDF
app.post('/api/gerar-termo', async (req, res) => {
  const dados = req.body;

  try {
    // grava no Sheets
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(dados);

    // mescla template .docx
    const content = fs.readFileSync(
      path.resolve(__dirname, 'Termo_Regularidade_CRP.docx'),
      'binary'
    );
    const zip = new PizZip(content);
    const docx = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true
    });
    docx.setData({
      ente:        dados.ente,
      cnpj:        dados.cnpj,
      uf:          dados.uf,
      orgaoGestor: dados.orgaoGestor || '',
      cidade:      dados.cidade || '',
      dia:         dados.dia || '',
      mes:         dados.mes || '',
      ano:         dados.ano || '',
      responsavel: dados.responsavel || '',
      criterios:   dados.criterios || []
    });
    docx.render();

    // salva DOCX temporário
    const bufDocx = docx.getZip().generate({ type: 'nodebuffer' });
    const tmpDocx = path.join(tmpDir, `termo_${Date.now()}.docx`);
    fs.writeFileSync(tmpDocx, bufDocx);

    // converte para PDF via LibreOffice CLI
    await new Promise((resolve, reject) => {
      const soffice = spawn('soffice', [
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        tmpDocx
      ]);
      soffice.on('exit', code =>
        code === 0 ? resolve() : reject(new Error('Falha na conversão para PDF'))
      );
    });

    const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
    const pdfBuf  = fs.readFileSync(pdfPath);

    // limpeza temporários
    fs.unlinkSync(tmpDocx);
    fs.unlinkSync(pdfPath);

    // retorna PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);

  } catch (err) {
    console.error('❌ Erro em /api/gerar-termo:', err);
    res.status(500).json({ error: 'Erro interno ao gerar termo.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
