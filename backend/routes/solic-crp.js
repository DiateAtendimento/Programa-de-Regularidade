// backend/routes/solic-crp.js
import { Router } from "express";
import { schemaSolicCrp } from "../schemas/schemaSolicCrp.js";
import { buscarGescon, buscarTermosRegistrados, salvarSolicCrp } from "../services/solicCrp.js";
import { pdfFromSolicCrp } from "../services/pdf/solicCrp.js";
import { schemaTermoSolicPdf } from "../schemas/schemaTermoSolicPdf.js";

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
     const c = digits(b.cnpj || b.cnpj_ente);
     if (c.length !== 14) return res.status(422).json({ error: 'VALIDATION', field: 'cnpj' });
     return res.json(await buscarGescon(c));
   } catch (e) { next(e); }
 });

 r.post("/termos-registrados", requireKey, async (req, res, next) => {
   try {
     const b = req.body || {};
     const c = digits(b.cnpj || b.cnpj_ente);
     if (c.length !== 14) return res.status(422).json({ error: 'VALIDATION', field: 'cnpj' });
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

// === PDF do Termo de Solicitação (CRP) ===
r.post("/termo-solic-crp-pdf", requireKey, async (req, res, next) => {
  try {
    const payload = schemaTermoSolicPdf.parse(req.body);
    const pdf = await pdfFromSolicCrp(payload);
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
