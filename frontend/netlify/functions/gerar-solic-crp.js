// netlify/functions/gerar-solic-crp.js
// Usa fetch nativo do Node 20

const TARGET = process.env.TARGET_API_BASE || process.env.API_BASE;

// remove chaves com string vazia, null ou undefined
function stripEmpty(o) {
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === null || typeof v === 'undefined') continue;
    out[k] = v;
  }
  return out;
}

// garante boolean (ou remove) nos campos que não podem ser string vazia
function normalizeBooleans(o, keys) {
  if (!o) return o;
  for (const k of keys) {
    if (!(k in o)) continue;
    const v = o[k];
    if (typeof v === 'boolean') continue;
    if (v === 'true')  { o[k] = true;  continue; }
    if (v === 'false') { o[k] = false; continue; }
    if (v === '' || v === null || typeof v === 'undefined') { delete o[k]; continue; }
    // qualquer outra coisa vira boolean coerced
    o[k] = !!v;
  }
  return o;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!TARGET) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: 'TARGET_API_BASE não configurado' }) };
  }

  try {
    const url = `${TARGET.replace(/\/+$/, '')}/api/gerar-solic-crp`;
    const headers = { 'Content-Type': 'application/json' };

    // Propaga X-API-Key e X-Idempotency-Key
    const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'];
    if (apiKey) headers['X-API-Key'] = apiKey;
    const idem = event.headers['x-idempotency-key'] || event.headers['X-Idempotency-Key'];
    if (idem) headers['X-Idempotency-Key'] = idem;

    // normaliza payload
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    normalizeBooleans(body, ['HAS_TERMO_ENC_GESCON']);
    body = stripEmpty(body);

    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body: text
    };
  } catch (e) {
    console.error('[gerar-solic-crp] upstream error:', e);
    return { statusCode: 502, body: JSON.stringify({ ok:false, error: 'Upstream unavailable' }) };
  }
};
