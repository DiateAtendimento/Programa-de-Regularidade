// frontend/netlify/functions/termo-solic-crp-pdf.js
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  // aceita { data: {...} } e também overrides opcionais
  const dataForTemplate = (payload && typeof payload === 'object' && payload.data) ? payload.data : payload;
  const overrideTemplateUrl = payload.templateUrl || process.env.TERMO_TEMPLATE_URL || '';

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);

    // 1) URL do TEMPLATE (nunca o form)
    const origin = resolveOrigin(event);
    const fallback = `${origin}/termo_solic_crp.html`;
    const templateUrl = (overrideTemplateUrl || fallback) + `?v=${Date.now()}`;

    const res = await page.goto(templateUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    const status = res?.status() || 0;

    // 2) Marca modo PDF no CSS
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // 3) Sanidade forte: URL final, título, seletor e ausência de inputs
    await page.waitForSelector('h1.term-title', { timeout: 20000 }).catch(() => {});

    const sanity = await page.evaluate(() => {
      const href = location.href;
      const title = document.title || '';
      const h1El = document.querySelector('h1.term-title');
      const h1 = (h1El?.textContent || '').trim();
      const okTitle = /TERMO DE SOLICITAÇÃO DE CRP EMERGENCIAL/i.test(h1);
      const hasFormControls = !!document.querySelector(
        'form, select, textarea, input[type=checkbox], input[type=radio], input[type=text], input[type=date], input[type=email]'
      );
      const hasPdfRoot = !!document.querySelector('#pdf-root .term-wrap');
      return { href, title, h1, okTitle, hasFormControls, hasPdfRoot };
    });

    // bloqueia se caiu no form ou se não é o template
    const urlLooksWrong =
      !sanity.hasPdfRoot ||
      !sanity.okTitle ||
      sanity.hasFormControls ||
      /form_gera_termo|solic_crp\.js|section-title/i.test(sanity.title);

    if (status >= 400 || urlLooksWrong) {
      throw new Error(
        [
          'Template incorreto para impressão.',
          `HTTP=${status}`,
          `loaded=${sanity.href}`,
          `title="${sanity.title}"`,
          `h1="${sanity.h1}" okTitle=${sanity.okTitle}`,
          `hasFormControls=${sanity.hasFormControls}`,
          `hasPdfRoot=${sanity.hasPdfRoot}`,
          'Dica: passe templateUrl no body ou configure TERMO_TEMPLATE_URL no Netlify apontando para /termo_solic_crp.html.'
        ].join(' | ')
      );
    }

    // 4) Injeta dados e sinaliza o template
    await page.evaluate((data) => {
      window.__TERMO_DATA__ = data;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, dataForTemplate);

    // 5) Emula mídia print e aguarda “ready”
    await page.emulateMediaType('print');
    await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 30000 });

    // 6) PDF A4
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
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    try { if (browser) await browser.close(); } catch {}
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'PDF error', message: String((err && err.message) || err) }),
    };
  }
};
