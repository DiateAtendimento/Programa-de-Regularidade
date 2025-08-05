// backend/server.js
require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors    = require('cors');
const PizZip  = require('pizzip');
const Docxtemplater = require('docxtemplater');
// ⚠️ usar v3.x para ter useServiceAccountAuth()
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());

// ——————————————————————————————
// 0) Preparações iniciais
// ——————————————————————————————

// 0.1) Verifica se o arquivo de credenciais existe
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ Arquivo de credenciais não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

// 0.2) Garante que a pasta de temporários exista
const tmpDir = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir);
}

// 0.3) Servir arquivos estáticos do frontend
app.use('/', express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————————
// 1) Configuração do Google Sheets
// ——————————————————————————————
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function authSheets() {
  // autentica e carrega metadados
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// ——————————————————————————————
// 2) Rota principal: gera termo e PDF
// ——————————————————————————————
app.post('/api/gerar-termo', async (req, res) => {
  const dados = req.body;

  try {
    // 2.1) Grava na planilha
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(dados);

    // 2.2) Carrega e mescla o template .docx
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

    // 2.3) Salva DOCX temporário
    const bufDocx = docx.getZip().generate({ type: 'nodebuffer' });
    const tmpDocx = path.join(tmpDir, `termo_${Date.now()}.docx`);
    fs.writeFileSync(tmpDocx, bufDocx);

    // 2.4) Converte para PDF via LibreOffice CLI
    await new Promise((resolve, reject) => {
      const soffice = spawn('soffice', [
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        tmpDocx
      ]);
      soffice.on('exit', code =>
        code === 0
          ? resolve()
          : reject(new Error('Falha na conversão para PDF'))
      );
    });

    const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
    const pdfBuf  = fs.readFileSync(pdfPath);

    // 2.5) Limpeza dos temporários
    fs.unlinkSync(tmpDocx);
    fs.unlinkSync(pdfPath);

    // 2.6) Envia o PDF ao cliente
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);

  } catch (err) {
    console.error('❌ Erro em /api/gerar-termo:', err);
    res.status(500).json({ error: 'Erro interno ao gerar termo.' });
  }
});

// ——————————————————————————————
// 3) Inicialização do servidor
// ——————————————————————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
