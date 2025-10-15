// netlify/functions/termo-solic-crp-pdf-v2.js
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

function resolveOrigin(event) {
  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const h = event.headers || {};
  const proto = h['x-forwarded-proto'] || h['x-nf-client-connection-proto'] || 'https';
  const host  = h['x-forwarded-host'] || h.host;
  return `${proto}://${host}`;
}

function now() { return Date.now(); }
function ms(t0){ return `${Date.now()-t0}ms`; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const t0 = now();

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const data    = (body && typeof body === 'object' && body.data) ? body.data : body;
  const origin  = resolveOrigin(event);
  const fallback = `${origin}/termo_solic_crp.html`;
  const templateUrl = (body.templateUrl || process.env.TERMO_TEMPLATE_URL || fallback);

  let browser;
  try {
    // 1) Baixa o HTML do template no servidor (sem render ainda)
    const tFetch = now();
    const resp = await fetch(`${templateUrl}?v=${Date.now()}`, { redirect: 'follow' });
    const status = resp.status || 0;
    if (status >= 400) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Template HTTP error', status }) };
    }
    let html = await resp.text();
    // injeta <base> para que URLs relativas (imgs/css) funcionem
    if (!/</i.test(html.slice(0, 300))) { // sanidade simples
      return { statusCode: 500, body: JSON.stringify({ error: 'Invalid template response' }) };
    }
    if (!/<base\s/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);
    }
    // Evita fonts externas de tela atrapalharem (não precisa p/ PDF)
    html = html.replace(/<link[^>]+fonts\.g(oogleapis|static)\.com[^>]*>/gi, '');
    console.log('[pdf] fetched template in', ms(tFetch));

    // 2) Sobe o Chromium
    const tBoot = now();
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('[pdf] chromium launched in', ms(tBoot));

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);
    await page.setDefaultNavigationTimeout(12000);

    // 3) Interceptação: permite MESMA ORIGEM (imgs/css), bloqueia externos desnecessários
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt  = req.resourceType();
      const url = req.url();
      const sameOrigin = url.startsWith(origin + '/');

      if (!sameOrigin) {
        // bloqueia tudo que não seja essencial e externo
        if (/google-analytics|gtm|doubleclick|facebook|hotjar|fonts\.g(oogleapis|static)\.com/i.test(url)) {
          return req.abort();
        }
        // css/imagens externas não são necessárias
        if (rt === 'stylesheet' || rt === 'image' || rt === 'font' || rt === 'media' || rt === 'eventsource') {
          return req.abort();
        }
      } else {
        // mesma origem → manter CSS e imagens do site (logos e termo_solic_crp.css)
        if (rt === 'eventsource' || rt === 'media' || rt === 'font') return req.abort();
      }
      return req.continue();
    });

    // 4) Carrega o HTML diretamente (sem navegar)
    const tSet = now();
    // injeta sinalizador de export antes de setar
    html = html.replace('</head>', `<script>document.documentElement.classList.add('pdf-export');document.addEventListener('DOMContentLoaded',()=>{document.body.classList.add('pdf-export');});</script></head>`);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 12000 });
    console.log('[pdf] setContent in', ms(tSet));

    // 5) Sanidade
    const sanity = await page.evaluate(() => {
      const title = document.title || '';
      const h1 = (document.querySelector('h1.term-title')?.textContent || '').trim();
      const okTitle = /TERMO DE SOLICITAÇÃO DE CRP EMERGENCIAL/i.test(h1);
      const hasFormControls = !!document.querySelector(
        'form, select, textarea, input[type=checkbox], input[type=radio], input[type=text], input[type=date], input[type=email]'
      );
      const hasPdfRoot = !!document.querySelector('#pdf-root .term-wrap');
      return { title, h1, okTitle, hasFormControls, hasPdfRoot };
    });
    if (!sanity.hasPdfRoot || !sanity.okTitle || sanity.hasFormControls || /Formulário|section-title/i.test(sanity.title)) {
      throw new Error(`Template inválido | title="${sanity.title}" | h1="${sanity.h1}" okTitle=${sanity.okTitle} hasFormControls=${sanity.hasFormControls} hasPdfRoot=${sanity.hasPdfRoot}`);
    }

    // 6) Injeta dados
    await page.evaluate((d) => {
      window.__TERMO_DATA__ = d;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, data);

    await page.emulateMediaType('print');

    // 7) Espera o sinal do template (curto) ou presence do root
    try {
      await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 5000 });
    } catch {
      const hasRoot = await page.$('#pdf-root .term-wrap');
      if (!hasRoot) throw new Error('PDF root não encontrado e TERMO_PRINT_READY não chegou');
    }

    // 8) Gera o PDF
    const tPdf = now();
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' },
    });
    console.log('[pdf] pdf() in', ms(tPdf), '| total', ms(t0));

    await page.close();
    await browser.close();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="solic-crp.pdf"',
        'Cache-Control': 'no-store',
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    try { if (browser) await browser.close(); } catch {}
    console.error('[pdf] ERROR:', err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'PDF error', message: String((err && err.message) || err) }),
    };
  }
};
