// netlify/functions/termo-solic-crp-pdf-v2.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

/** Resolve a origem do deploy (produção/preview/dev) */
function resolveOrigin(event) {
  const envUrl =
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const h = event.headers || {};
  const proto =
    h['x-forwarded-proto'] || h['x-nf-client-connection-proto'] || 'https';
  const host = h['x-forwarded-host'] || h.host;
  return `${proto}://${host}`;
}

exports.handler = async (event) => {
  // CORS/preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      },
      body: ''
    };
  }

  // Healthcheck / warm-up
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ ok: true, fn: 'termo-solic-crp-pdf-v2' })
    };
  }

  console.time('[pdf] total');
  console.log('[pdf] start, node', process.version, '| headless?', chromium.headless);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Payload
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[pdf] invalid JSON body:', e && e.message);
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  const data = (body && typeof body === 'object' && body.data) ? body.data : body;

  // Template
  const origin = resolveOrigin(event);
  const fallback = `${origin}/termo_solic_crp.html`;
  const templateUrl = (body.templateUrl || process.env.TERMO_TEMPLATE_URL || fallback) + `?v=${Date.now()}`;
  console.log('[pdf] origin:', origin);
  console.log('[pdf] templateUrl:', templateUrl);

  let browser;
  try {
    // ===== LAUNCH (com retry p/ cold start) =====
    async function launchWithRetry() {
      const opts = {
        args: [
          ...chromium.args,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      };

      console.time('[pdf] launch');
      try {
        return await puppeteer.launch(opts);
      } catch (e) {
        console.warn('[pdf] launch fail (1ª tentativa):', e && e.message);
        await new Promise((r) => setTimeout(r, 800));
        console.time('[pdf] relaunch');
        const b = await puppeteer.launch(opts);
        console.timeEnd('[pdf] relaunch');
        return b;
      } finally {
        console.timeEnd('[pdf] launch');
      }
    }

    browser = await launchWithRetry();
    const page = await browser.newPage();

    // ===== ÚNICA interceptação de requests (evita conflitos) =====
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        const url = req.url();
        const rt = req.resourceType();
        const isExternal = !url.startsWith(origin);

        // 1) Bloqueia fontes/analytics e recursos pesados
        if (rt === 'font' ||
            /fonts\.googleapis\.com/i.test(url) ||
            /google-analytics|gtm|doubleclick|facebook|hotjar/i.test(url)) {
          return req.abort();
        }
        if (rt === 'image' || rt === 'media' || rt === 'eventsource') {
          return req.abort();
        }
        if (rt === 'stylesheet' && isExternal) {
          return req.abort();
        }

        // 2) CSS vazio para chamadas do Google Fonts (caso escapem pelo tipo)
        if (/fonts\.googleapis\.com/i.test(url)) {
          return req.respond({ status: 200, contentType: 'text/css', body: '/* fonts blocked */' });
        }

        // 3) SVGs de logo — entrega via fetch do Node (evita 403 intermitentes)
        if (/\/imagens\/logo-(secretaria-complementar|termo-drpps)\.svg$/i.test(url)) {
          try {
            const r = await fetch(url, { cache: 'no-store' });
            const svg = await r.text();
            return req.respond({ status: 200, contentType: 'image/svg+xml', body: svg });
          } catch (e) {
            console.warn('[pdf][logo] fallback continue()', e?.message);
            return req.continue();
          }
        }

        return req.continue();
      } catch (e) {
        // Qualquer falha na interceptação — segue a solicitação
        try { return req.continue(); } catch (_) {}
      }
    });

    await page.setJavaScriptEnabled(true);

    // Logs úteis
    page.on('console', (msg) => {
      try { console.log('[pdf][browser]', msg.type(), msg.text()); } catch {}
    });
    page.on('pageerror', (err) => console.error('[pdf][pageerror]', err && err.message));
    page.on('requestfailed', (req) =>
      console.warn('[pdf][requestfailed]', req.url(), req.failure() && req.failure().errorText)
    );

    // ===== Navegação com retry =====
    async function gotoWithRetry(url) {
      console.time('[pdf] goto');
      try {
        return await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      } catch (e) {
        console.warn('[pdf] goto fail (1ª):', e && e.message);
        await new Promise((r) => setTimeout(r, 500));
        return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } finally {
        console.timeEnd('[pdf] goto');
      }
    }

    const res = await gotoWithRetry(templateUrl);
    const status = res?.status() || 0;
    console.log('[pdf] HTTP status do template:', status);

    // Marcações p/ CSS de impressão
    await page.evaluate(() => {
      document.documentElement.classList.add('pdf-export');
      document.body.classList.add('pdf-export');
    });

    // Sanity do template
    console.time('[pdf] sanity');
    await page.waitForSelector('h1.term-title', { timeout: 25000 }).catch(() => {});
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

    // Injeta dados do termo
    console.time('[pdf] inject-data');
    await page.evaluate((d) => {
      window.__TERMO_DATA__ = d;
      document.dispatchEvent(new CustomEvent('TERMO_DATA_READY'));
      console.log('TERMO_DATA injected keys:', Object.keys(d || {}));
    }, data);
    console.timeEnd('[pdf] inject-data');

    // Espera sinalização de pronto (ou fallback)
    console.time('[pdf] wait-print-ready');
    await page.emulateMediaType('print');
    try {
      await page.waitForFunction('window.__TERMO_PRINT_READY__ === true', { timeout: 8000 });
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
      margin: { top: '18mm', right: '12mm', bottom: '18mm', left: '12mm' }
    });
    console.timeEnd('[pdf] generate');

    await page.close();
    await browser.close();
    console.timeEnd('[pdf] total');

    // Sucesso
    const reqId =
      (event.headers && (event.headers['x-nf-request-id'] || event.headers['X-NF-Request-ID'])) || '';
    console.log('[pdf] done, x-nf-request-id:', reqId);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="solic-crp.pdf"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Request-Id': String(reqId)
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    console.error('[pdf] ERROR:', err && (err.stack || err.message || err));
    try { if (browser) await browser.close(); } catch (e) { console.warn('[pdf] browser.close fail', e && e.message); }
    console.timeEnd('[pdf] total');

    const reqId =
      (event.headers && (event.headers['x-nf-request-id'] || event.headers['X-NF-Request-ID'])) || '';

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Request-Id': String(reqId)
      },
      body: JSON.stringify({
        error: 'PDF error',
        message: String((err && err.message) || err),
        requestId: reqId
      })
    };
  }
};
