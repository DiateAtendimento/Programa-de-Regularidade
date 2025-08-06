// backend/server.js
require('dotenv').config();

const fs                     = require('fs');
const path                   = require('path');
const express                = require('express');
const helmet                 = require('helmet');
const cors                   = require('cors');
const rateLimit              = require('express-rate-limit');
const hpp                    = require('hpp');
const { GoogleSpreadsheet }  = require('google-spreadsheet');

const app = express();

// ——————————————————————————————
// Basic security headers
// ——————————————————————————————
app.disable('x-powered-by');
app.use(helmet());

// ——————————————————————————————
// Rate limiting (prevent brute‐force / DoS)
// ——————————————————————————————
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                 // limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ——————————————————————————————
// Prevent HTTP parameter pollution
// ——————————————————————————————
app.use(hpp());

// ——————————————————————————————
// CORS configuration
// ——————————————————————————————
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://seu-dominio.com',
  methods: ['GET', 'POST'],
}));

// ——————————————————————————————
// Body parser with size limit
// ——————————————————————————————
app.use(express.json({ limit: '10kb' }));

// ——————————————————————————————
// Serve frontend static files
// ——————————————————————————————
app.use('/', express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————————
// Preparations: load credentials
// ——————————————————————————————
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json not found at ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

// ——————————————————————————————
// Google Sheets setup
// ——————————————————————————————
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// ——————————————————————————————
// API endpoint: save data to Google Sheets
// ——————————————————————————————
app.post('/api/gerar-termo', async (req, res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error writing to Google Sheets:', err);
    res.status(500).json({ error: 'Failed to write to Google Sheets.' });
  }
});

// ——————————————————————————————
// Start server
// ——————————————————————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
