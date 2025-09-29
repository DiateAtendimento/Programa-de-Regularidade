import { Router } from "express";
import { schemaSolicCrp } from "../schemas/schemaSolicCrp.js";
import { buscarGescon, buscarTermosRegistrados, salvarSolicCrp } from "../services/solicCrp.js";
import { pdfFromSolicCrp } from "../services/pdf/solicCrp.js";

const r = Router();
const apiKey = process.env.API_KEY;
const requireKey = (req,res,next)=>{
  if (!apiKey) return next();
  if (req.get("X-API-Key") === apiKey) return next();
  return res.status(401).json({ error: "Unauthorized" });
};

r.post("/gescon/termo-enc", requireKey, async (req,res,next)=>{
  try{ const { cnpj } = req.body||{}; return res.json(await buscarGescon(cnpj)); }
  catch(e){ next(e); }
});

r.post("/termos-registrados", requireKey, async (req,res,next)=>{
  try{ const { cnpj } = req.body||{}; return res.json(await buscarTermosRegistrados(cnpj)); }
  catch(e){ next(e); }
});

r.post("/gerar-solic-crp", requireKey, async (req,res,next)=>{
  try{
    const idem = req.get("X-Idempotency-Key") || "";
    const payload = schemaSolicCrp.parse(req.body);
    await salvarSolicCrp(payload, idem);
    res.json({ ok:true });
  }catch(e){ next(e); }
});

r.post("/termo-solic-crp-pdf", requireKey, async (req,res,next)=>{
  try{
    const payload = schemaSolicCrp.parse(req.body);
    const pdf = await pdfFromSolicCrp(payload);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",'attachment; filename="solic-crp.pdf"');
    res.send(pdf);
  }catch(e){ next(e); }
});

export default r;
