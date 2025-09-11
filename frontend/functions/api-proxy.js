// Netlify Function que encaminha para o Render injetando a API key
export async function handler(event) {
  // ----- CORS / preflight -----
  const origin = event.headers?.origin || '*';
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type,Cache-Control,X-Idempotency-Key,X-API-Key,Authorization',
        Vary: 'Origin',
      },
    };
  }

  // ----- Config -----
  const API_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com').replace(/\/+$/, '');
  const API_KEY = process.env.API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
      body: JSON.stringify({ error: 'API_KEY não definida no ambiente do Netlify.' }),
    };
  }

  // ----- Normaliza subpath (aceita /_api/... ou /.netlify/functions/api-proxy/...) -----
  const url = new URL(event.rawUrl);
  let subpath = url.pathname;

  for (const base of ['/.netlify/functions/api-proxy', '/_api']) {
    if (subpath.startsWith(base)) {
      subpath = subpath.slice(base.length);
      break;
    }
  }
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  // Rota de health local (opcional, deixa mais rápido e não exige key)
  if (subpath === '/health') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
      body: JSON.stringify({ ok: true }),
    };
  }

  // Monta destino no Render
  const search = url.search || '';
  const target = `${API_BASE}/api${subpath}${search}`;

  // Headers a repassar + injeção de credenciais
  const pass = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const lk = k.toLowerCase();
    if (['content-type', 'cache-control', 'x-idempotency-key', 'user-agent'].includes(lk)) {
      pass[k] = v;
    }
  }

  // Injeção da API key em formatos diferentes
  pass['x-api-key'] = API_KEY;
  pass['X-API-Key'] = API_KEY;
  pass['authorization'] = `Bearer ${API_KEY}`;

  // Encaminha a requisição
  const res = await fetch(target, {
    method: event.httpMethod,
    headers: pass,
    body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : event.body,
  });

  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const isTextLike = /^text\/|application\/(json|javascript)/i.test(ct);

  const outHeaders = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
  const cd = res.headers.get('content-disposition');
  if (cd) outHeaders['Content-Disposition'] = cd;

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: isTextLike ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isTextLike,
  };
}
