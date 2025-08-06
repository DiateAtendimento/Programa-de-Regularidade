// backend/server.js
require('dotenv').config();

const fs                    = require('fs');
const path                  = require('path');
const express               = require('express');
const helmet                = require('helmet');
const cors                  = require('cors');
const rateLimit             = require('express-rate-limit');
const hpp                   = require('hpp');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();

// ——————————————————————————————
// 1) Security: disable X-Powered-By + Helmet headers
// ——————————————————————————————
app.disable('x-powered-by');
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": [
        "'self'",
        "https://cdn.jsdelivr.net",          
        "https://cdnjs.cloudflare.com",      
        "'unsafe-inline'"                    
      ],
      "style-src": [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
        "'unsafe-inline'"
      ],
      "font-src": [
        "'self'",
        "https://fonts.gstatic.com"
      ],
      "img-src": [
        "'self'",
        "data:"
      ],
      "connect-src": [
        "'self'"
      ],
      "frame-src": ["'none'"],
      "object-src": ["'none'"]
    }
  })
);

// ——————————————————————————————
// 2) Rate Limiting (prevent brute‐force / DoS)
// ——————————————————————————————
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// ——————————————————————————————
// 3) Prevent HTTP Parameter Pollution
// ——————————————————————————————
app.use(hpp());

// ——————————————————————————————
// 4) CORS (origens autorizadas)
// ——————————————————————————————
const allowedOrigins = [
  process.env.CORS_ORIGIN,                        
  'https://programa-de-regularidade.netlify.app'  
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`Origin ${origin} não autorizada pelo CORS`));
  },
  methods: ['GET','POST'],
}));

// ——————————————————————————————
// 5) Body parser (com limite de payload)
// ——————————————————————————————
app.use(express.json({ limit: '10kb' }));

// ——————————————————————————————
// 6) Serve frontend estático
// ——————————————————————————————
app.use('/', express.static(path.join(__dirname, '../frontend')));
app.use('/animacao', express.static(path.join(__dirname, '../frontend/animacao')));

// ——————————————————————————————
// 7) Preparação das credenciais do Google Sheets
// ——————————————————————————————
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

// ——————————————————————————————
// 8) Configuração do GoogleSpreadsheet
// ——————————————————————————————
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// ——————————————————————————————
// 9) Endpoint para gravação no Sheets
// ——————————————————————————————
app.post('/api/gerar-termo', async (req, res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(req.body);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Falha ao gravar no Google Sheets:', err);
    return res.status(500).json({ error: 'Failed to write to Google Sheets.' });
  }
});

// ——————————————————————————————
// 10) Inicia o servidor
// ——————————————————————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
