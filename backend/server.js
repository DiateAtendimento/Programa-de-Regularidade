// backend/server.js
require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors    = require('cors');
const PizZip  = require('pizzip');
const Docxtemplater = require('docxtemplater');
// ⚠️ garanta ter instalado: npm install google-spreadsheet@3.3.0
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());

// ——————————————————————————————
// 1) Configuração do Google Sheets
// ——————————————————————————————
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
// carrega o JSON da service account
const creds = require(path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH));

async function authSheets() {
  // autentica e carrega metadados
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// ——————————————————————————————
// 2) Rota de teste do Google Sheets
// ——————————————————————————————
app.get('/api/test-sheets', async (req, res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({ teste: 'ok', data: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) {
    console.error('Erro no test-sheets:', e);
    res.status(500).json({ error: e.toString() });
  }
});

// ——————————————————————————————
// 3) Rota principal: gera termo e PDF
// ——————————————————————————————
app.post('/api/gerar-termo', async (req, res) => {
  const dados = req.body;

  try {
    // 3.1) Grava na planilha
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(dados);

    // 3.2) Carrega e mescla o template .docx
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
      responsavel: dados.responsavel || ''
    });
    docx.render();

    // 3.3) Salva DOCX temporário
    const bufDocx = docx.getZip().generate({ type: 'nodebuffer' });
    const tmpDir  = path.resolve(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const tmpDocx = path.join(tmpDir, `termo_${Date.now()}.docx`);
    fs.writeFileSync(tmpDocx, bufDocx);

    // 3.4) Converte para PDF (LibreOffice CLI)
    await new Promise((resolve, reject) => {
      const soffice = spawn('soffice', [
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        tmpDocx
      ]);
      soffice.on('exit', code =>
        code === 0 ?
          resolve() :
          reject(new Error('Conversion para PDF falhou'))
      );
    });

    const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
    const pdfBuf  = fs.readFileSync(pdfPath);

    // 3.5) Limpeza de arquivos temporários
    fs.unlinkSync(tmpDocx);
    fs.unlinkSync(pdfPath);

    // 3.6) Retorna o PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);

  } catch (err) {
    console.error('Erro em gerar-termo:', err);
    res.status(500).json({ error: 'Erro interno ao gerar termo.' });
  }
});

// ——————————————————————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
