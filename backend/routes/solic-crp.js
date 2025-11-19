// backend/routes/solic-crp.js
import { Router } from "express";
import { schemaSolicCrp } from "../schemas/schemaSolicCrp.js";
import { buscarGescon, buscarTermosRegistrados, salvarSolicCrp } from "../services/solicCrp.js";
// import { pdfFromSolicCrp } from "../services/pdf/solicCrp.js"; // Substituído pela lógica direta abaixo
import { schemaTermoSolicPdf } from "../schemas/schemaTermoSolicPdf.js";

// NOVOS IMPORTS para Puppeteer e Path
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

// Definição de __dirname para ambiente ES Module (necessário para path.join)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const r = Router();

const apiKey = process.env.API_KEY;
const requireKey = (req, res, next) => {
  if (!apiKey) return next();
  if (req.get("X-API-Key") === apiKey) return next();
  return res.status(401).json({ error: "Unauthorized" });
};

// Helpers de normalização
const digits = (s) => String(s || "").replace(/\D/g, "");
const toISO = (s) => {
  if (!s) return "";
  const t = String(s).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) {
    const [d, m, y] = t.split("/");
    return `${y}-${m}-${d}`;
  }
  return t; // assume já ISO
};

// === GESCON / Termos registrados ===
r.post("/gescon/termo-enc", requireKey, async (req, res, next) => {
  try {
    const b = req.body || {};
    const c = digits(b.cnpj || b.cnpj_ente || b.CNPJ_ENTE);
    if (c.length !== 14) return res.status(422).json({ error: "VALIDATION", field: "cnpj" });
    return res.json(await buscarGescon(c));
  } catch (e) { next(e); }
});

r.post("/termos-registrados", requireKey, async (req, res, next) => {
  try {
    const b = req.body || {};
    const c = digits(b.cnpj || b.cnpj_ente || b.CNPJ_ENTE);
    if (c.length !== 14) return res.status(422).json({ error: "VALIDATION", field: "cnpj" });
    return res.json(await buscarTermosRegistrados(c));
  } catch (e) { next(e); }
});

// === Registrar Solicitação CRP ===
r.post("/gerar-solic-crp", requireKey, async (req, res, next) => {
  try {
    const idem = req.get("X-Idempotency-Key") || "";

    // Normaliza antes de validar
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const normalized = {
      ...body,
      CNPJ_ENTE: digits(body.CNPJ_ENTE),
      CNPJ_UG: digits(body.CNPJ_UG),
      CPF_REP_ENTE: digits(body.CPF_REP_ENTE),
      CPF_REP_UG: digits(body.CPF_REP_UG),
      DATA_VENCIMENTO_ULTIMO_CRP: toISO(body.DATA_VENCIMENTO_ULTIMO_CRP),
    };

    const data = schemaSolicCrp.parse(normalized);

    // salvarSolicCrp deve: respeitar idempotência e retornar { ok:true, sheet, rowId, idempotent? }
    const result = await salvarSolicCrp(data, idem);
    return res.json(result && result.ok ? result : { ok: true, ...result });

  } catch (e) {
    // Zod → 422 com detalhes
    if (e?.issues) {
      return res.status(422).json({ ok: false, error: "Schema validation", details: e.issues });
    }
    next(e);
  }
});

// ---------------------------------------------------------------------
// === PDF do Termo de Solicitação (CRP) – Lógica ATUALIZADA ===
// ---------------------------------------------------------------------
r.post("/termo-solic-crp-pdf", requireKey, async (req, res, next) => {
  try {
    const payload = schemaTermoSolicPdf.parse(req.body);
    
    // Início do NOVO TRECHO com Puppeteer garantido
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    // 1. Abre o modelo HTML correto
    // Ajuste o caminho 'termo_solic_crp.html' se a sua estrutura de pastas for diferente.
    // O caminho abaixo assume que 'solic-crp.js' está em 'backend/routes' e o HTML em 'frontend'.
    const template = path.join(__dirname, "../../frontend/termo_solic_crp.html");
    await page.goto("file://" + template, { waitUntil: "networkidle0" });

    // 2. Injeta o payload completo e executa o script do template (window.run)
    await page.evaluate((data) => {
      if (window.run) {
        window.run(data);               // usa a função do próprio HTML para preencher (incluindo F43_*)
      } else if (window.postMessage) {
        window.postMessage({ type: "TERMO_DATA", payload: data }, "*");
      }
    }, payload);

    // 3. Gera o PDF com o HTML já preenchido
    const pdf = await page.pdf({ format: "A4", printBackground: true });

    await browser.close();
    // Fim do NOVO TRECHO

    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",'attachment; filename="solic-crp.pdf"');
    return res.send(pdf);
  } catch (e) {
    if (e?.issues) {
      return res.status(422).json({ ok: false, error: "Schema validation", details: e.issues });
    }
    next(e);
  }
});

export default r;