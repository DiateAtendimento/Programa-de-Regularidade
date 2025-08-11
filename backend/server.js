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

/* ================================
 * 1) Segurança básica (Helmet + headers)
 * ================================ */
app.disable('x-powered-by');

// ajustes para evitar conflitos com pdf/canvas e recursos externos
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));

// CSP enxuta; ajuste domínios se precisar
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      "style-src": ["'self'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "'unsafe-inline'"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://programa-de-regularidade.onrender.com"],
      "frame-src": ["'none'"],
      "object-src": ["'none'"]
    }
  })
);

/* ================================
 * 2) Rate limiting
 * ================================ */
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ================================
 * 3) Prevenção de HTTP Parameter Pollution
 * ================================ */
app.use(hpp());

/* ================================
 * 4) CORS (inclui OPTIONS / preflight)
 * ================================ */
const allowedOrigins = [
  "https://programa-de-regularidade.netlify.app",
  process.env.CORS_ORIGIN // opcional via .env
].filter(Boolean);

const corsOpts = {
  origin: (origin, cb) => {
    // permite requisições sem Origin (ex.: curl, healthchecks)
    if (!origin) return cb(null, true);

    const ok = allowedOrigins.some(o =>
      origin === o || (o.endsWith('.netlify.app') && origin.endsWith('.netlify.app'))
    );
    return ok ? cb(null, true) : cb(new Error(`Origin não autorizada: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

app.use(cors(corsOpts));
app.options('*', cors(corsOpts)); // libera preflight globalmente

/* ================================
 * 5) Body parser (limite de JSON)
 * ================================ */
app.use(express.json({ limit: "10kb" }));

/* ================================
 * 6) Arquivos estáticos (frontend + animações)
 * ================================ */
app.use("/", express.static(path.join(__dirname, "../frontend")));
app.use("/animacao", express.static(path.join(__dirname, "../frontend/animacao")));

/* ================================
 * 7) Credenciais do Google Sheets
 * ================================ */
const credsPath = path.resolve(__dirname, process.env.CREDENTIALS_JSON_PATH);
if (!fs.existsSync(credsPath)) {
  console.error(`❌ credentials.json não encontrado em ${credsPath}`);
  process.exit(1);
}
const creds = require(credsPath);

/* ================================
 * 8) Configuração do GoogleSpreadsheet
 * ================================ */
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function authSheets() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

/* ================================
 * 9) Endpoints
 * ================================ */

// 9.0) Gravar na aba "Dados"
app.post("/api/gerar-termo", async (req, res) => {
  try {
    await authSheets();
    const sheet = doc.sheetsByTitle["Dados"];

    // timestamp PT-BR (fuso São Paulo)
    const now = new Date();
    const timestampDate = now.toLocaleDateString("pt-BR");
    const timestampTime = now.toLocaleTimeString("pt-BR", {
      hour12: false,
      timeZone: "America/Sao_Paulo",
    });

    const row = {
      ...req.body,   // CNPJ, UF, ENTE, CARGO, CPF, NOME, etc.
      DATA: timestampDate,
      HORA: timestampTime,
    };

    await sheet.addRow(row);
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Falha ao gravar no Google Sheets:", err);
    return res.status(500).json({ error: "Failed to write to Google Sheets." });
  }
});

// 9.1) Lista de entes para autocomplete (aba "Fonte")
app.get("/api/entes", async (_req, res) => {
  try {
    await authSheets();
    const fonteSheet = doc.sheetsByTitle["Fonte"];
    const rows = await fonteSheet.getRows();
    const entes = rows.map((r) => ({
      uf: (r.UF || '').toString().trim(),
      ente: (r.ENTE || '').toString().trim(),
    }));
    return res.json(entes);
  } catch (err) {
    console.error("❌ Falha ao buscar entes:", err);
    return res.status(500).json({ error: "Erro interno ao obter lista de entes." });
  }
});

/* ================================
 * 10) Inicia servidor
 * ================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
