//server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Prepara Google Sheets
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));

async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// Rota principal
app.post('/api/gerar-termo', async (req, res) => {
  const dados = req.body;

  try {
    // 1) Grava na planilha
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(dados);

    // 2) Carrega o template .docx
    const content = fs.readFileSync(path.resolve(__dirname, 'Termo_Regularidade_CRP.docx'), 'binary');
    const zip     = new PizZip(content);
    const docx    = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    // 3) Mescla os dados
    docx.setData({
      ente:        dados.ente,
      cnpj:        dados.cnpj,
      uf:          dados.uf,
      orgaoGestor: dados.orgaoGestor || '',
      cidade:      dados.cidade || '',
      dia:         dados.dia || '',
      mes:         dados.mes || '',
      ano:         dados.ano || '',
      responsavel: dados.responsavel || ''
    });
    docx.render();

    // 4) Salva novo DOCX temporário
    const bufDocx = docx.getZip().generate({ type: 'nodebuffer' });
    const tmpDocx = path.resolve(__dirname, 'tmp', `termo_${Date.now()}.docx`);
    fs.writeFileSync(tmpDocx, bufDocx);

    // 5) Converte para PDF usando LibreOffice CLI
    await new Promise((resolve, reject) => {
      const soffice = spawn('soffice', [
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', path.dirname(tmpDocx),
        tmpDocx
      ]);
      soffice.on('exit', code => code === 0 ? resolve() : reject(new Error('Conversion failed')));
    });

    const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
    const pdfBuf  = fs.readFileSync(pdfPath);

    // 6) Limpa arquivos temporários (opcional)
    fs.unlinkSync(tmpDocx);
    fs.unlinkSync(pdfPath);

    // 7) Retorna o PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno ao gerar termo.' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
