#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--html') out.html = args[++i];
    else if (a === '--out') out.out = args[++i];
    else if (a === '--data') out.data = args[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}

(async () => {
  const opts = parseArgs();
  if (opts.help || !opts.html || !opts.out) {
    console.log('Uso: node scripts/generate-termo-pdf.js --html frontend/termo.html --out termo.pdf [--data payload.json]');
    process.exit(opts.help ? 0 : 1);
  }

  const htmlPath = path.isAbsolute(opts.html) ? opts.html : path.join(process.cwd(), opts.html);
  if (!fs.existsSync(htmlPath)) { console.error('Arquivo HTML não encontrado:', htmlPath); process.exit(2); }

  const outPath = path.isAbsolute(opts.out) ? opts.out : path.join(process.cwd(), opts.out);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType('screen');

    const htmlUrl = pathToFileURL(htmlPath).href;
    await page.goto(htmlUrl, { waitUntil: 'networkidle0' });

    if (opts.data) {
      const dataPath = path.isAbsolute(opts.data) ? opts.data : path.join(process.cwd(), opts.data);
      if (!fs.existsSync(dataPath)) console.warn('Arquivo de dados não encontrado, ignorando:', dataPath);
      else {
        const raw = fs.readFileSync(dataPath, 'utf8');
        let payload;
        try { payload = JSON.parse(raw); } catch (e) { console.error('JSON inválido em --data'); process.exit(3); }
        await page.evaluate((p) => {
          window.__TERMO_DATA__ = p;
          document.dispatchEvent(new Event('TERMO_DATA_READY'));
        }, payload);
      }
    }

    // espera a flag do termo.js
    try {
      await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 10000 });
    } catch (e) {
      console.warn('timeout esperando TERMO_PRINT_READY — prosseguindo (verifique renderização)');
    }

    // gera PDF sem headerTemplate (o header é controlado pelo CSS @media print fixo)
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '16mm', bottom: '20mm', left: '16mm' }
    });

    console.log('PDF gerado em', outPath);
  } finally {
    await browser.close();
  }
})();