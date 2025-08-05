//server.js
require('dotenv').config();

const fs             = require('fs');
const path           = require('path');
const { spawn }      = require('child_process');
const express        = require('express');
const cors           = require('cors');
const PizZip         = require('pizzip');
const Docxtemplater  = require('docxtemplater');
// usar v3.x: npm install google-spreadsheet@3.3.0
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors());
app.use(express.json());
// serve o frontend estático
app.use('/', express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————————
// preparações iniciais
// ——————————————————————————————
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

const tmpDir = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir);
}

// ——————————————————————————————
// Google Sheets
// ——————————————————————————————
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// ——————————————————————————————
// rota principal: gerar termo e PDF
// ——————————————————————————————
app.post('/api/gerar-termo', async (req, res) => {
  const dados = req.body;

  try {
    // 1) grava no Google Sheets
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(dados);

    // 2) carrega e mescla template .docx
    const content = fs.readFileSync(
      path.resolve(__dirname, 'Termo_Regularidade_CRP.docx'),
      'binary'
    );
    const zip  = new PizZip(content);
    const docx = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    // 3) injeta TODOS os campos no template
    docx.setData({
      // Identificação
      ente:        dados.ente        || '',
      cnpj:        dados.cnpj        || '',
      uf:          dados.uf          || '',
      orgaoGestor: dados.orgaoGestor || '',

      // Dados Pessoais
      cpf:         dados.cpf         || '',
      nome:        dados.nome        || '',
      criterios:   Array.isArray(dados.criterios) ? dados.criterios : [dados.criterios].filter(Boolean),
      telefone:    dados.telefone    || '',
      email:       dados.email       || '',
      endereco:    dados.endereco    || '',

      // Rodapé
      cidade:      dados.cidade      || '',
      dia:         dados.dia         || '',
      mes:         dados.mes         || '',
      ano:         dados.ano         || '',
      responsavel: dados.responsavel || ''
    });
    docx.render();

    // 4) salva DOCX temporário
    const bufDocx  = docx.getZip().generate({ type: 'nodebuffer' });
    const tmpDocx  = path.join(tmpDir, `termo_${Date.now()}.docx`);
    fs.writeFileSync(tmpDocx, bufDocx);

    // 5) converte para PDF via LibreOffice CLI
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

    // 6) lê PDF gerado e retorna
    const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
    const pdfBuf  = fs.readFileSync(pdfPath);

    // 7) limpa temporários
    fs.unlinkSync(tmpDocx);
    fs.unlinkSync(pdfPath);

    // 8) envia o PDF ao cliente
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);

  } catch (err) {
    console.error('❌ Erro em /api/gerar-termo:', err);
    // exibe sub-erros de template, se houver
    if (err.properties && Array.isArray(err.properties.errors)) {
      err.properties.errors.forEach((e, i) => {
        console.error(` ↳ sub-erro[${i}]:`, e);
      });
    }
    return res.status(500).json({
      error: 'Erro interno ao gerar termo (veja console do servidor).'
    });
  }
});

// ——————————————————————————————
// inicialização do servidor
// ——————————————————————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
