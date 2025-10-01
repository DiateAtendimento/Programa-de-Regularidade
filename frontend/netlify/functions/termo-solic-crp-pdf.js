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

  // aceita tanto { data: {...} } quanto o objeto plano
  const dataForTemplate = (payload && typeof payload === 'object' && payload.data)
    ? payload.data
    : payload;

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

    // 1) Abre o TEMPLATE de impressão (não o formulário)
    const origin = resolveOrigin(event);
    const templateUrl = `${origin}/termo_solic_crp.html?v=${Date.now()}`;
    await page.goto(templateUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    // 2) Marca modo PDF pelo CSS
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // 3) Verificações de sanidade: título + ausência de controles de form
    await page.waitForSelector('h1.term-title', { timeout: 15000 });
    const sanity = await page.evaluate(() => {
      const h1 = (document.querySelector('h1.term-title')?.textContent || '').trim();
      const hasFormControls = !!document.querySelector(
        'form, select, textarea, input[type=checkbox], input[type=radio], input[type=text], input[type=date], input[type=email]'
      );
      return {
        h1,
        okTitle: /TERMO DE SOLICITAÇÃO DE CRP EMERGENCIAL/i.test(h1),
        hasFormControls
      };
    });

    if (!sanity.okTitle || sanity.hasFormControls) {
      throw new Error(
        `Template incorreto para impressão. h1="${sanity.h1}" ` +
        `(okTitle=${sanity.okTitle}) hasFormControls=${sanity.hasFormControls}. ` +
        `Verifique se /termo_solic_crp.html está sendo servido (e não o form).`
      );
    }

    // 4) Injeta dados e sinaliza o template
    await page.evaluate((data) => {
      window.__TERMO_DATA__ = data;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, dataForTemplate);

    // 5) Emula mídia print e aguarda o "ready" do template
    await page.emulateMediaType('print');
    await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 30000 });

    // 6) Gera PDF A4
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
