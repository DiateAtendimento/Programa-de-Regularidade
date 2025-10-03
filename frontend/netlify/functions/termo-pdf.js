// netlify/functions/termo-pdf.js  (Formulário 1)
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data } = JSON.parse(event.body || '{}') || {};
  if (!data) return { statusCode: 400, body: 'payload ausente' };

  const origin = process.env.PUBLIC_ORIGIN || `https://${event.headers.host}`;
  const templateUrl = `${origin}/termo.html?v=${Date.now()}`; // <- TEMPLATE do Form 1

  const browser = await puppeteer.launch({
    args: chromium.args, defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(), headless: chromium.headless
  });
  try {
    const page = await browser.newPage();
    await page.goto(templateUrl, { waitUntil: ['load','domcontentloaded','networkidle0'], timeout: 60000 });

    // injeta classes de exportação e mídia de impressão
    await page.emulateMediaType('print');
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // injeta os dados e sinaliza para o front renderizar
    await page.evaluate((_data) => {
      window.__TERMO_DATA__ = _data;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
    }, data);

    // sanity checks (evita PDF em branco)
    await page.waitForSelector('#pdf-root .term-wrap', { timeout: 15000 });
    await page.waitForFunction(() => !!window.__TERMO_PRINT_READY__ === true, { timeout: 30000 });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="termo-adesao.pdf"'
      },
      body: Buffer.from(pdf).toString('base64'),
      isBase64Encoded: true
    };
  } finally {
    await browser.close();
  }
};
