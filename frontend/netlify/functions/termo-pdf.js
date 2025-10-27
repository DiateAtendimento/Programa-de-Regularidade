// backend/termo-pdf.js
const path = require('path');
const express = require('express');
const router = express.Router();

/**
 * Gera PDF do termo de ADESÃO.
 * Espera um JSON no body com os campos usados pelo template /termo.html.
 */
router.post('/pdf/termo', async (req, res) => {
  const t0 = Date.now();
  const log = (m, obj) => console.log(`[termo-pdf] ${m}`, obj ?? '');
  const errlog = (m, obj) => console.error(`[termo-pdf][ERROR] ${m}`, obj ?? '');

  const { browser } = req.app.locals; // puppeteer compartilhado pelo server
  const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:8888';
  const url = `${PUBLIC_URL}/termo.html`;

  let page;
  try {
    page = await browser.newPage();

    // 1) Ver console do template
    page.on('console', msg => {
      const type = msg.type();
      const txt = msg.text();
      if (type === 'error') errlog(`console(${type}): ${txt}`);
      else log(`console(${type}): ${txt}`);
    });

    // 2) Injeta payload ANTES do carregamento do template
    const payload = req.body || {};
    await page.evaluateOnNewDocument((data) => {
      // entregue no escopo global
      window.__TERMO_DATA__ = data || {};
      // liga o modo de exportação para CSS
      document.documentElement.classList.add('pdf-export');
      document.body?.classList?.add('pdf-export');
    }, payload);

    // 3) Abre o HTML do termo
    log('Abrindo template', { url });
    const resp = await page.goto(url, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'], timeout: 60000 });
    log('Status navegação', { status: resp?.status?.() });

    // 4) Garante mídia e fonte
    await page.emulateMediaType('print');

    // 5) Verifica se realmente renderizou conteúdo
    const bodySize = await page.evaluate(() => {
      const b = document.body;
      return { w: b?.scrollWidth || 0, h: b?.scrollHeight || 0, html: !!document.querySelector('#pdf-root') };
    });
    log('Body size', bodySize);
    if (!bodySize.html || bodySize.h < 100) {
      throw new Error(`Conteúdo não renderizado (#pdf-root? ${bodySize.html}) altura=${bodySize.h}`);
    }

    // 6) Gera PDF
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    });

    const dt = Date.now() - t0;
    log('PDF gerado com sucesso', { ms: dt, kb: Math.round(pdf.length / 1024) });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="termo-adesao.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    errlog('Falha ao gerar PDF', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    try { await page?.close(); } catch {}
  }
});

module.exports = router;
