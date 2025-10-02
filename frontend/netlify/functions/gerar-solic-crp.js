// frontend/netlify/functions/gerar-solic-crp.js
const fetch = require('node-fetch');

// Ex.: https://programa-de-regularidade.onrender.com  (defina em Netlify)
// Fallback para API_BASE, se você já usa esse nome.
const TARGET = process.env.TARGET_API_BASE || process.env.API_BASE;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!TARGET) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: 'TARGET_API_BASE não configurado' }) };
  }

  try {
    const url = `${TARGET.replace(/\/+$/, '')}/gerar-solic-crp`; // <- CASA COM O SEU backend/routes
    const headers = { 'Content-Type': 'application/json' };

    // Propaga X-API-Key e X-Idempotency-Key
    const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'];
    if (apiKey) headers['X-API-Key'] = apiKey;

    const idem = event.headers['x-idempotency-key'] || event.headers['X-Idempotency-Key'];
    if (idem) headers['X-Idempotency-Key'] = idem;

    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: event.body || '{}'
    });

    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body
    };
  } catch (e) {
    console.error('[gerar-solic-crp] upstream error:', e);
    return { statusCode: 502, body: JSON.stringify({ ok:false, error: 'Upstream unavailable' }) };
  }
};
