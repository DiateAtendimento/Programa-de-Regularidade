// netlify/functions/gerar-solic-crp.js
// Usa fetch nativo do Node 20 + LOGS detalhados

const TARGET = process.env.TARGET_API_BASE || process.env.API_BASE;

// util: anonimiza dados sensíveis nos logs
function mask(v = '') {
  const s = String(v);
  if (/^\d{11,14}$/.test(s)) return s.replace(/\d(?=\d{4})/g, '•'); // CPF/CNPJ
  if (s.includes('@')) {
    const [u, d] = s.split('@');
    return (u.length <= 2 ? '••' : u.slice(0, 2) + '••') + '@' + d;
  }
  if (s.length > 12) return s.slice(0, 4) + '…' + s.slice(-4);
  return s;
}

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
    o[k] = !!v;
  }
  return o;
}

exports.handler = async (event) => {
  console.time('[gerar-solic] total');
  console.log('[gerar-solic] start | node', process.version, '| TARGET?', !!TARGET);

  if (event.httpMethod !== 'POST') {
    console.warn('[gerar-solic] method not allowed:', event.httpMethod);
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!TARGET) {
    console.error('[gerar-solic] TARGET_API_BASE/API_BASE ausente');
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: 'TARGET_API_BASE não configurado' }) };
  }

  try {
    // normaliza payload
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) {
      console.error('[gerar-solic] JSON parse error:', e && e.message);
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'JSON inválido' }) };
    }

    normalizeBooleans(body, ['HAS_TERMO_ENC_GESCON']);
    body = stripEmpty(body);

    // loga chaves e alguns campos-chave mascarados
    const peek = {
      ESFERA: body.ESFERA,
      UF: body.UF,
      ENTE: body.ENTE,
      CNPJ_ENTE: mask(body.CNPJ_ENTE),
      CNPJ_UG: mask(body.CNPJ_UG),
      CPF_REP_ENTE: mask(body.CPF_REP_ENTE),
      CPF_REP_UG: mask(body.CPF_REP_UG),
      EMAIL_ENTE: mask(body.EMAIL_ENTE),
      EMAIL_UG: mask(body.EMAIL_UG),
      FASE_PROGRAMA: body.FASE_PROGRAMA,
      HAS_TERMO_ENC_GESCON: body.HAS_TERMO_ENC_GESCON,
    };
    console.log('[gerar-solic] payload keys:', Object.keys(body || {}));
    console.log('[gerar-solic] payload peek:', peek);

    const url = `${TARGET.replace(/\/+$/, '')}/api/gerar-solic-crp`;
    const headers = { 'Content-Type': 'application/json' };

    // Propaga X-API-Key e X-Idempotency-Key (com fallback para variável de ambiente)
    const hdrs = event.headers || {};
    const apiKey = hdrs['x-api-key'] || hdrs['X-API-Key'] || process.env.API_KEY || '';
    if (apiKey) headers['X-API-Key'] = apiKey;
    const idem = hdrs['x-idempotency-key'] || hdrs['X-Idempotency-Key'] || '';
    if (idem) headers['X-Idempotency-Key'] = idem;

    console.log('[gerar-solic] POST →', url);
    console.log('[gerar-solic] headers →', {
      'Content-Type': headers['Content-Type'],
      'X-API-Key': apiKey ? '(present)' : '(none)',
      'X-Idempotency-Key': idem ? mask(idem) : '(none)'
    });

    // timeout simples via AbortController (25s)
    const ac = new AbortController();
    const timeout = setTimeout(() => {
      console.warn('[gerar-solic] aborting upstream fetch (timeout)');
      ac.abort();
    }, 25000);

    console.time('[gerar-solic] upstream');
    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } finally {
      clearTimeout(timeout);
      console.timeEnd('[gerar-solic] upstream');
    }

    const text = await upstream.text();
    console.log('[gerar-solic] upstream status:', upstream.status, '| content-type:', upstream.headers.get('content-type') || '(none)', '| len:', text.length);

    console.timeEnd('[gerar-solic] total');
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body: text
    };
  } catch (e) {
    console.error('[gerar-solic] upstream error:', e && (e.stack || e.message || e));
    console.timeEnd('[gerar-solic] total');
    return { statusCode: 502, body: JSON.stringify({ ok:false, error: 'Upstream unavailable' }) };
  }
};
