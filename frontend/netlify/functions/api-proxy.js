// netlify/functions/api-proxy.js
const UPSTREAM_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';

// 👇 aceita CORS_ALLOWLIST OU CORS_ORIGIN_LIST
const _allow = process.env.CORS_ALLOWLIST || process.env.CORS_ORIGIN_LIST || '';
const ORIGIN_ALLOWLIST = _allow.split(',').map(s => s.trim()).filter(Boolean);

const PATH_ALLOWLIST = [
  /^\/gescon\/termo-enc$/i,
  /^\/termos-registrados$/i,
  /^\/gerar-solic-crp$/i,
  /^\/termo-solic-crp-pdf$/i,
  /^\/termo-solic-crp-pdf-v2$/i,
  /^\/health$/i,
  /^\/_diag$/i,
  /^\/_probe$/i,         // 👈 utilitário de diagnóstico
];

export async function handler(event) {
  const requestOrigin = event.headers?.origin || '';
  const originAllowed = isOriginAllowed(requestOrigin);
  const corsOrigin = originAllowed ? requestOrigin : '*';

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Cache-Control,X-Idempotency-Key,X-API-Key,Authorization,X-Requested-With',
        'Access-Control-Max-Age': '3600',
        Vary: 'Origin',
      },
    };
  }

  if (!API_KEY) return json(500, { error: 'API_KEY não definida no ambiente do Netlify.' }, corsOrigin);

  const url = new URL(event.rawUrl);
  let subpath = url.pathname;
  for (const base of ['/.netlify/functions/api-proxy', '/_api']) {
    if (subpath.startsWith(base)) { subpath = subpath.slice(base.length); break; }
  }
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  if (subpath === '/health') return json(200, { ok: true }, corsOrigin);
  if (subpath === '/_diag')  return json(200, {
    ok: true, hasApiKey: !!API_KEY, apiKeyLen: API_KEY.length, apiBase: UPSTREAM_BASE,
    originAllowed, origin: requestOrigin || null,
    corsAllowlist: ORIGIN_ALLOWLIST,
  }, corsOrigin);

  // 👇 Utilitário para testar upstream rapidamente
  if (subpath === '/_probe') {
    const cnpj = (url.searchParams.get('cnpj') || '').replace(/\D+/g,'');
    if (cnpj.length !== 14) return json(400, { error: 'Informe ?cnpj=14 dígitos' }, corsOrigin);

    const target = `${UPSTREAM_BASE}/api/gescon/termo-enc`;
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnpj })
    }).catch(e => ({ status: 599, headers: new Headers(), text: async () => String(e) }));

    const ct = r.headers.get('content-type') || '';
    const sample = await r.text();
    return json(200, {
      try: 'POST /api/gescon/termo-enc',
      target, sentHeaders: { 'X-API-Key': `***${API_KEY.slice(-4)}` },
      upstreamStatus: r.status, upstreamCT: ct,
      sample: sample.slice(0, 400)
    }, corsOrigin);
  }

  if (!PATH_ALLOWLIST.some(rx => rx.test(subpath))) {
    return json(403, { error: 'Rota não permitida no proxy.', subpath }, corsOrigin);
  }

  const target = `${UPSTREAM_BASE}/api${subpath}${url.search || ''}`;

  const h = new Headers();
  const src = event.headers || {};
  if (src['content-type'])      h.set('Content-Type', src['content-type']);
  if (src['cache-control'])     h.set('Cache-Control', src['cache-control']);
  if (src['x-idempotency-key']) h.set('X-Idempotency-Key', src['x-idempotency-key']);
  if (src['authorization'])     h.set('Authorization', src['authorization']);
  h.set('Accept', 'application/json, */*');
  h.set('X-API-Key', API_KEY);

  let body;
  if (!['GET','HEAD'].includes(event.httpMethod)) {
    body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort('proxy-timeout'), 25000);

  let res;
  try {
    res = await fetch(target, { method: event.httpMethod, headers: h, body, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(t);
    const msg = String(err?.message || err || '');
    return json(msg.includes('timeout') ? 504 : 502, { error: 'Upstream error', detail: msg, target }, corsOrigin);
  }
  clearTimeout(t);

  const upstreamCT = res.headers.get('content-type') || 'application/octet-stream';
  const isText = /^text\/|application\/(json|javascript|pdf)/i.test(upstreamCT) && !/^application\/octet-stream$/i.test(upstreamCT);
  const buf = Buffer.from(await res.arrayBuffer());

  const outHeaders = { 'Content-Type': upstreamCT, 'Access-Control-Allow-Origin': corsOrigin, Vary: 'Origin' };
  ['Content-Disposition','Cache-Control','ETag','Last-Modified'].forEach(k => {
    const v = res.headers.get(k); if (v) outHeaders[k] = v;
  });

  return { statusCode: res.status, headers: outHeaders, body: isText ? buf.toString('utf8') : buf.toString('base64'), isBase64Encoded: !isText };
}

function json(status, obj, origin='*'){ return { statusCode: status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin, Vary:'Origin' }, body: JSON.stringify(obj) }; }
function isOriginAllowed(origin){ if(!origin) return true; if(!ORIGIN_ALLOWLIST.length) return true; return ORIGIN_ALLOWLIST.includes(origin); }
