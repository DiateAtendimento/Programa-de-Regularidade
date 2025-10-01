// frontend/netlify/functions/termo-solic-crp-pdf.js
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// helper: resolve origem do site publicado (https://...netlify.app)
function getOrigin(headers) {
  const proto =
    headers["x-forwarded-proto"] ||
    headers["x-nf-client-connection-proto"] ||
    "https";
  const host = headers["x-forwarded-host"] || headers.host;
  return `${proto}://${host}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  let browser;
  try {
    // launch headless chrome (sparticuz)
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // 1) Navega para o TEMPLATE DE IMPRESSÃO (não o formulário!)
    const origin = getOrigin(event.headers || {});
    const templateUrl = `${origin}/termo_solic_crp.html`;

    // 2) Carrega a página e injeta os dados do termo
    await page.goto(templateUrl, { waitUntil: "networkidle0" });

    // injeta os dados e avisa o template (ele dispara TERMO_PRINT_READY)
    await page.evaluate((data) => {
      window.__TERMO_DATA__ = data;
      document.dispatchEvent(new CustomEvent("TERMO_DATA_READY"));
    }, payload);

    // 3) Garante mídia de impressão e espera o “ready”
    await page.emulateMediaType("print");
    await page.waitForFunction("window.__TERMO_PRINT_READY__ === true", {
      timeout: 15000,
    });

    // 4) Gera PDF (A4, com fundos)
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "18mm", right: "12mm", bottom: "18mm", left: "12mm" },
    });

    await page.close();
    await browser.close();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="solic-crp.pdf"',
        "Cache-Control": "no-store",
      },
      body: pdf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    try { if (browser) await browser.close(); } catch {}
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "PDF error", message: String(err && err.message || err) }),
    };
  }
};
