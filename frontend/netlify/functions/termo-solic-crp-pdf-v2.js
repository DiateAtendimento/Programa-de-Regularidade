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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // aceita { data: {...} } ou o objeto direto
  const data = (body && typeof body === 'object' && body.data) ? body.data : body;

  const origin   = resolveOrigin(event);
  const fallback = `${origin}/termo_solic_crp.html`;
  const templateUrl = (body.templateUrl || process.env.TERMO_TEMPLATE_URL || fallback) + `?v=${Date.now()}`;

  let browser;
  try {
    // --- Lançamento do Chromium (headless-lambda) ---
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);
    await page.setDefaultNavigationTimeout(90000); // mais folga em cold start

    // --- Interceptação: evita fontes externas e ruído (acelera boot) ---
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      // bloqueia fonts.googleapis e fonts.gstatic (só usadas no preview)
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(url)) {
        return req.abort();
      }
      // deixa passar imagens, css e tudo do próprio site
      return req.continue();
    });

    // --- GOTO com pequeno retry (backoff) ---
    const navOpts = { waitUntil: 'networkidle0', timeout: 90000 };
    let res, status = 0, lastErr = null;
    for (let tent = 1, delay = 600; tent <= 2; tent++) {
      try {
        res = await page.goto(templateUrl, navOpts);
        status = res?.status() || 0;
        if (status < 400) break; // OK
      } catch (e) {
        lastErr = e;
      }
      if (tent < 2) await new Promise(r => setTimeout(r, delay));
    }
    if (!res || status >= 400) {
      throw new Error(`Falha ao carregar template (${status || 'sem resposta'}) em ${templateUrl}. ${(lastErr && lastErr.message) || ''}`);
    }

    // --- Marca modo PDF via CSS ---
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // --- Sanidade forte (garante que NÃO é o formulário) ---
    await page.waitForSelector('h1.term-title', { timeout: 20000 }).catch(() => {});
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

    const looksWrong =
      !sanity.hasPdfRoot || !sanity.okTitle || sanity.hasFormControls ||
      /Formulário|section-title/i.test(sanity.title);

    if (looksWrong) {
      throw new Error(
        `Template inválido para impressão | loaded=${sanity.href} | title="${sanity.title}" | ` +
        `h1="${sanity.h1}" okTitle=${sanity.okTitle} hasFormControls=${sanity.hasFormControls} hasPdfRoot=${sanity.hasPdfRoot}`
      );
    }

    // --- Injeta os dados e sinaliza o template ---
    await page.evaluate((d) => {
      window.__TERMO_DATA__ = d;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, data);

    // --- Prepara para impressão e aguarda o "ready" do template ---
    await page.emulateMediaType('print');
    await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 30000 });

    // --- Gera o PDF A4 ---
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' },
    });

    await page.close();
    await browser.close();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="solic-crp.pdf"',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('PDF error:', err && err.stack || err);
    try { if (browser) await browser.close(); } catch {}
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: 'PDF error',
        message: String((err && err.message) || err)
      }),
    };
  }
};
