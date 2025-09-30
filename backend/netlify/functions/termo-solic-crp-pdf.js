// netlify/functions/termo-solic-crp-pdf.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // 1) Lê o corpo e aceita {data:{...}} ou o objeto direto
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    let data = body?.data ?? body ?? {};

    // 2) (Opcional, mas recomendado) Valida com o seu schema (ESM)
    try {
      // caminho a partir de netlify/functions/ até a raiz do projeto
      const mod = await import('../../schemaSolicCrp.js'); // <-- usa seu arquivo original
      if (mod && mod.schemaSolicCrp) {
        const res = mod.schemaSolicCrp.safeParse(data);
        if (!res.success) {
          return {
            statusCode: 422,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: false, errors: res.error.flatten() })
          };
        }
        data = res.data; // payload já normalizado pelo Zod
      }
    } catch { /* se não conseguir importar o schema, segue sem travar */ }

    // 3) URL absoluta do template (mesmo domínio do site)
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host  = event.headers['x-forwarded-host'] || event.headers.host;
    const templateUrl = `${proto}://${host}/termo_solic_crp.html`;

    // 4) Sobe o Chromium headless
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // 5) Expõe os dados para o template
    await page.exposeFunction('__getTermoData__', () => data);

    // 6) Abre o template e injeta os dados
    await page.goto(templateUrl, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.evaluate(async () => {
      const payload = await window.__getTermoData__();
      window.__TERMO_DATA__ = payload;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    });

    // 7) Espera o template sinalizar que está pronto
    await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 120000 });

    // 8) Gera o PDF
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '12mm', bottom: '16mm', left: '12mm' }
    });

    await browser.close();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="termo-solicitacao-crp.pdf"',
        'Cache-Control': 'no-store'
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Erro ao gerar PDF: ' + (err?.message || String(err)) };
  }
};
