// netlify/functions/api-proxy.js
// Proxy genérico para /_api/* → backend (Render). Com CORS, allowlist de rotas,
// decodificação base64 do body, timeout e diagnósticos.

const UPSTREAM_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';
const ORIGIN_ALLOWLIST = (process.env.CORS_ALLOWLIST || '')
  .split(',').map(s => s.trim()).filter(Boolean); // ex: "https://meusite.netlify.app,https://dominio.gov.br"

// Rotas do backend permitidas pelo proxy (evita tunneling arbitrário)
const PATH_ALLOWLIST = [
  /^\/gescon\/termo-enc$/i,
  /^\/termos-registrados$/i,
  /^\/gerar-solic-crp$/i,
  /^\/termo-solic-crp-pdf$/i,
  /^\/termo-solic-crp-pdf-v2$/i,
  /^\/health$/i,    // utilitárias do próprio backend, se existirem
];

export async function handler(event) {
  const requestOrigin = event.headers?.origin || '';
  const originAllowed = isOriginAllowed(requestOrigin);
  const corsOrigin = originAllowed ? requestOrigin : '*';

  // --- Preflight CORS ---
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

  if (!API_KEY) {
    return json(500, { error: 'API_KEY não definida no ambiente do Netlify.' }, corsOrigin);
  }

  // --- Caminho solicitado ---
  const url = new URL(event.rawUrl);
  let subpath = url.pathname;
  for (const base of ['/.netlify/functions/api-proxy', '/_api']) {
    if (subpath.startsWith(base)) { subpath = subpath.slice(base.length); break; }
  }
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  // Rotas locais utilitárias
  if (subpath === '/health') return json(200, { ok: true }, corsOrigin);
  if (subpath === '/_diag')  return json(200, {
    ok: true,
    hasApiKey: !!API_KEY,
    apiKeyLen: API_KEY.length,
    apiBase: UPSTREAM_BASE,
    originAllowed,
    origin: requestOrigin || null,
  }, corsOrigin);

  if (!PATH_ALLOWLIST.some(rx => rx.test(subpath))) {
    return json(403, { error: 'Rota não permitida no proxy.', subpath }, corsOrigin);
  }

  // --- Monta URL do upstream (sempre prefixa /api) ---
  const target = `${UPSTREAM_BASE}/api${subpath}${url.search || ''}`;

  // --- Monta headers (propaga alguns, injeta credencial) ---
  const h = new Headers();
  const src = event.headers || {};
  if (src['content-type'])      h.set('Content-Type', src['content-type']);
  if (src['cache-control'])     h.set('Cache-Control', src['cache-control']);
  if (src['x-idempotency-key']) h.set('X-Idempotency-Key', src['x-idempotency-key']);
  if (src['authorization'])     h.set('Authorization', src['authorization']); // repassa se existir
  h.set('Accept', 'application/json, */*');
  h.set('X-API-Key', API_KEY);

  // --- Body (decodifica se veio base64) ---
  let body = undefined;
  if (!['GET', 'HEAD'].includes(event.httpMethod)) {
    if (event.isBase64Encoded) {
      body = Buffer.from(event.body || '', 'base64');
    } else {
      body = event.body;
    }
  }

  // --- Timeout p/ não pendurar a função ---
  const ctrl = new AbortController();
  const timeoutMs = 25000; // 25s
  const t = setTimeout(() => ctrl.abort('proxy-timeout'), timeoutMs);

  let res;
  try {
    res = await fetch(target, {
      method: event.httpMethod,
      headers: h,
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const msg = (err && String(err.message || err)) || 'fetch error';
    // 504: melhor dica ao frontend (ex.: “Servidor demorou a responder”)
    return json(msg.includes('timeout') ? 504 : 502, { error: 'Upstream error', detail: msg, target }, corsOrigin);
  }
  clearTimeout(t);

  // --- Resposta ---
  const upstreamCT = res.headers.get('content-type') || 'application/octet-stream';
  const isText = /^text\/|application\/(json|javascript|pdf)/i.test(upstreamCT) && !/^application\/octet-stream$/i.test(upstreamCT);
  const buf = Buffer.from(await res.arrayBuffer());

  const outHeaders = {
    'Content-Type': upstreamCT,
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
  };

  // Propaga cabeçalhos úteis quando existirem
  const copy = (k) => {
    const v = res.headers.get(k);
    if (v) outHeaders[k] = v;
  };
  ['Content-Disposition', 'Cache-Control', 'ETag', 'Last-Modified'].forEach(copy);

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: isText ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isText,
  };
}

// Helpers
function json(status, obj, origin = '*') {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    },
    body: JSON.stringify(obj),
  };
}

function isOriginAllowed(origin) {
  if (!origin) return true; // navegação direta
  if (!ORIGIN_ALLOWLIST.length) return true; // sem restrição configurada
  return ORIGIN_ALLOWLIST.includes(origin);
}
