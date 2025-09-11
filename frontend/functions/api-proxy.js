// Netlify Function que encaminha para o Render injetando a API key
export async function handler(event) {
  const origin = event.headers?.origin || '*';

  // ----- CORS / preflight -----
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
  const API_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com')
    .replace(/\/+$/, '');
  const API_KEY = process.env.API_KEY;

  if (!API_KEY) {
    return json(500, { error: 'API_KEY não definida no ambiente do Netlify.' }, origin);
  }

  // ----- Normaliza subpath (aceita /_api/... ou /.netlify/functions/api-proxy/...) -----
  const rawUrl = safeUrlFromEvent(event);
  let subpath = rawUrl.pathname;

  for (const base of ['/.netlify/functions/api-proxy', '/_api']) {
    if (subpath.startsWith(base)) {
      subpath = subpath.slice(base.length);
      break;
    }
  }
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  // evita /api/api/... : se já veio com /api no início, removemos para prefixar só uma vez
  if (subpath === '/api' || subpath.startsWith('/api/')) {
    subpath = subpath.replace(/^\/api\/?/, '/');
  }

  // Rotas utilitárias locais (sem exigir chamada ao Render)
  if (subpath === '/health') {
    return json(200, { ok: true }, origin);
  }
  if (subpath === '/_diag') {
    const k = process.env.API_KEY || '';
    return json(
      200,
      {
        hasApiKey: !!k,
        apiKeyLen: k.length,
        apiBase: API_BASE,
      },
      '*' // diag pode ser público
    );
  }

  // Monta destino no Render (sempre prefixando /api)
  const search = rawUrl.search || '';
  const target = `${API_BASE}/api${subpath}${search}`;

  // Cabeçalhos a repassar do cliente
  const pass = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const lk = k.toLowerCase();
    if (
      [
        'content-type',
        'cache-control',
        'x-idempotency-key',
        'user-agent',
        'accept',
        'accept-language',
      ].includes(lk)
    ) {
      pass[k] = v;
    }
    // Repassa IP do cliente quando disponível
    if (lk === 'x-nf-client-connection-ip' || lk === 'x-forwarded-for') {
      pass['x-forwarded-for'] = v;
    }
  }

  // Injeção da API key (três formatos)
  pass['X-API-Key'] = API_KEY;
  pass['x-api-key'] = API_KEY;
  pass['authorization'] = `Bearer ${API_KEY}`;

  // Corpo da requisição (respeita isBase64Encoded)
  const isGetLike = event.httpMethod === 'GET' || event.httpMethod === 'HEAD';
  let outBody;
  if (!isGetLike && event.body) {
    outBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  }

  // Encaminha ao Render
  const res = await fetch(target, {
    method: event.httpMethod,
    headers: pass,
    body: outBody,
  });

  // Trata resposta
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const isTextLike = /^text\/|application\/(json|javascript)/i.test(ct);

  const outHeaders = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };

  // repassa cabeçalhos úteis (ex.: download de PDF)
  const cd = res.headers.get('content-disposition');
  if (cd) outHeaders['Content-Disposition'] = cd;
  const cc = res.headers.get('cache-control');
  if (cc) outHeaders['Cache-Control'] = cc;
  const et = res.headers.get('etag');
  if (et) outHeaders['ETag'] = et;

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: isTextLike ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isTextLike,
  };
}

// ---------- helpers ----------
function safeUrlFromEvent(event) {
  try {
    // event.rawUrl existe nas Functions modernas
    if (event.rawUrl) return new URL(event.rawUrl);
    const host = event.headers?.host || 'localhost';
    const proto = (event.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const qs = event.rawQuery ? `?${event.rawQuery}` : '';
    return new URL(`${proto}://${host}${event.path || ''}${qs}`);
  } catch {
    return new URL('https://localhost/');
  }
}

function json(statusCode, obj, origin = '*') {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    },
    body: JSON.stringify(obj),
  };
}
