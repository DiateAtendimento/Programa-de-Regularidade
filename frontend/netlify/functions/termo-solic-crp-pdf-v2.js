// netlify/functions/termo-solic-crp-pdf-v2.js
'use strict';

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

function resolveOrigin(event) {
  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const h = event.headers || {};
  const proto = h['x-forwarded-proto'] || h['x-nf-client-connection-proto'] || 'https';
  const host  = h['x-forwarded-host'] || h.host;
  return `${proto}://${host}`;
}

exports.handler = async (event) => {
  console.time('[pdf] total');
  console.log('[pdf] start, node', process.version, '| headless?', chromium.headless);

  // ---- Warmup: GET /api/termo-solic-crp-pdf?warmup=1 ----
  const qsp = event.queryStringParameters || {};
  const isWarmup = event.httpMethod === 'GET' && (qsp.warmup === '1' || qsp.warmup === 'true');
  if (isWarmup) {
    console.log('[pdf] warmup ping');
    try {
      console.time('[pdf] warmup launch+close');
      const b = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
      await b.close();
      console.timeEnd('[pdf] warmup launch+close');
    } catch (e) {
      console.warn('[pdf] warmup err:', e && e.message);
    }
    console.timeEnd('[pdf] total');
    return { statusCode: 204, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ---- Parse body ----
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[pdf] invalid JSON body:', e && e.message);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const data = (body && typeof body === 'object' && body.data) ? body.data : body;
  const origin = resolveOrigin(event);
  const fallback = `${origin}/termo_solic_crp.html`;
  const templateUrl = (body.templateUrl || process.env.TERMO_TEMPLATE_URL || fallback) + `?v=${Date.now()}`;
  console.log('[pdf] origin:', origin);
  console.log('[pdf] templateUrl:', templateUrl);

  let browser;
  try {
    console.time('[pdf] launch');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.timeEnd('[pdf] launch');

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);

    // Encaminha logs do browser p/ função
    page.on('console', (msg) => {
      try { console.log('[pdf][browser]', msg.type(), msg.text()); } catch {}
    });
    page.on('pageerror', (err) => console.error('[pdf][pageerror]', err && err.message));
    page.on('requestfailed', (req) =>
      console.warn('[pdf][requestfailed]', req.url(), req.failure() && req.failure().errorText)
    );

    // Bloqueia recursos pesados/externos
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      const url = req.url();
      const isExternal = !url.startsWith(origin);

      // corta mídia/pesados sempre
      if (rt === 'image' || rt === 'media' || rt === 'eventsource') return req.abort();
      if (rt === 'font' || /google-analytics|gtm|doubleclick|facebook|hotjar/i.test(url)) return req.abort();

      // corta recursos externos (fora da origin) que não são o documento principal
      if (isExternal && (rt === 'stylesheet' || rt === 'script' || rt === 'xhr' || rt === 'fetch')) {
        return req.abort();
      }

      return req.continue();
    });

    // Navegação rápida (fail-fast)
    console.time('[pdf] goto');
    const res = await page.goto(templateUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const status = res?.status() || 0;
    console.timeEnd('[pdf] goto');
    console.log('[pdf] HTTP status do template:', status);

    // Marcações para CSS de impressão
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // Sanity check do conteúdo
    console.time('[pdf] sanity');
    await page.waitForSelector('h1.term-title', { timeout: 20000 }).catch(()=>{});
    const sanity = await page.evaluate(() => {
      const href = location.href;
      const title = document.title || '';
      const h1 = (document.querySelector('h1.term-title')?.textContent || '').trim();
      const okTitle = /TERMO DE SOLICITAÇÃO DE CRP EMERGENCIAL/i.test(h1);
      const hasFormControls = !!document.querySelector(
        'form, select, textarea, input[type=checkbox], input[type=radio], input[type=text], input[type=date], input[type=email]'
      );
      const hasPdfRoot = !!document.querySelector('#pdf-root .term-wrap');
      return { href, title, h1, okTitle, hasFormControls, hasPdfRoot };
    });
    console.log('[pdf] sanity:', sanity);
    const looksWrong =
      !sanity.hasPdfRoot || !sanity.okTitle || sanity.hasFormControls ||
      /Formulário|section-title/i.test(sanity.title);
    if (status >= 400 || looksWrong) {
      throw new Error(
        `Template inválido | HTTP=${status} | loaded=${sanity.href} | title="${sanity.title}" | ` +
        `h1="${sanity.h1}" okTitle=${sanity.okTitle} hasFormControls=${sanity.hasFormControls} hasPdfRoot=${sanity.hasPdfRoot}`
      );
    }
    console.timeEnd('[pdf] sanity');

    // Injeta dados
    console.time('[pdf] inject-data');
    await page.evaluate((d) => {
      window.__TERMO_DATA__ = d;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
      console.log('TERMO_DATA injected keys:', Object.keys(d || {}));
    }, data);
    console.timeEnd('[pdf] inject-data');

    // Aguarda "print-ready" (fail-soft)
    console.time('[pdf] wait-print-ready');
    await page.emulateMediaType('print');
    try {
      await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 7000 });
    } catch {
      const hasRoot = await page.$('#pdf-root .term-wrap');
      if (!hasRoot) throw new Error('PDF root não encontrado e TERMO_PRINT_READY não chegou');
      console.warn('[pdf] TERMO_PRINT_READY não sinalizado; seguindo com fallback (tem #pdf-root)');
    }
    console.timeEnd('[pdf] wait-print-ready');

    // Gera PDF
    console.time('[pdf] generate');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' },
    });
    console.timeEnd('[pdf] generate');

    await page.close();
    await browser.close();

    console.timeEnd('[pdf] total');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="solic-crp.pdf"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[pdf] ERROR:', err && (err.stack || err.message || err));
    try { if (browser) await browser.close(); } catch (e) { console.warn('[pdf] browser.close fail', e && e.message); }
    console.timeEnd('[pdf] total');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'PDF error', message: String((err && err.message) || err) }),
    };
  }
};
