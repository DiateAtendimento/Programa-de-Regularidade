// frontend/netlify/functions/termo-solic-crp-pdf.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Origem publicada do site (Netlify)
function resolveOrigin(event) {
  // Preferir env do Netlify (produção / preview)
  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  // Fallback via headers
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

    const origin = resolveOrigin(event);
    const templateUrl = `${origin}/termo_solic_crp.html?v=${Date.now()}`;

    // 1) Navega para o TEMPLATE DE IMPRESSÃO
    await page.goto(templateUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    // 2) Garante modo de exportação (seus CSS já têm seletores .pdf-export)
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // 3) Injeta dados + dispara o evento que o template escuta
    await page.evaluate((data) => {
      window.__TERMO_DATA__ = data;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, payload);

    // 4) Emula mídia print e espera sinal de pronto
    await page.emulateMediaType('print');

    // Opcional: espere também o H1 do template correto aparecer
    await page.waitForSelector('h1.term-title', { timeout: 15000 });

    // Verificação de sanidade — impedir gerar do form por engano
    const h1 = (await page.$eval('h1.term-title', el => el.textContent || '')).trim();
    if (!/SOLICITAÇÃO DE CRP EMERGENCIAL/i.test(h1)) {
      throw new Error('Página errada: esperado termo_solic_crp.html (print), mas o conteúdo não bate com o template.');
    }

    // Espera o hook do template (setado pelo seu script)
    await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 30000 });

    // 5) Gera PDF (A4)
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
      body: JSON.stringify({ error: 'PDF error', message: String(err && err.message || err) }),
    };
  }
};
