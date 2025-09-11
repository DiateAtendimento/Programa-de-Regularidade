// Serverless Function no Netlify que injeta X-API-Key e repassa ao Render
export async function handler(event) {
  const ORIGIN = process.env.CORS_ORIGIN || event.headers.origin || '*';

  // CORS / preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Cache-Control, X-Idempotency-Key, X-API-Key, api-key, x-api-key',
        'Vary': 'Origin'
      }
    };
  }

  const API_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com')
    .replace(/\/+$/, '');

  // Remover prefixo da Function
  let subpath = event.path.replace(/^\/\.netlify\/functions\/api-proxy/, '');
  // Remover também qualquer "/_api" inicial (quando vem via redirect)
  subpath = subpath.replace(/^\/_api(?:\/|$)/, '/');

  // Normaliza: garante exatamente um "/api/" no início do destino
  if (!subpath.startsWith('/api/')) {
    subpath = '/api' + (subpath.startsWith('/') ? subpath : `/${subpath}`);
  }

  // Health local (aceita /health e /api/health)
  if (subpath === '/api/health') {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Content-Type': 'application/json', 'Vary': 'Origin' },
      body: JSON.stringify({ ok: true })
    };
  }

  const qs = event.rawQuery ? `?${event.rawQuery}` : '';
  const target = `${API_BASE}${subpath}${qs}`;

  // Copia alguns headers úteis do cliente
  const pass = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const lk = k.toLowerCase();
    if (['content-type', 'cache-control', 'x-idempotency-key'].includes(lk)) pass[k] = v;
  }

  // Injeta a API key do servidor (suporta vários nomes)
  const apiKey = process.env.API_KEY || process.env.X_API_KEY;
  if (apiKey) {
    pass['x-api-key'] = apiKey;
    pass['api-key'] = apiKey;
    pass['X-API-Key'] = apiKey;
  }

  // Monta init da requisição
  const init = { method: event.httpMethod, headers: pass };
  if (!['GET', 'HEAD'].includes(event.httpMethod)) {
    init.body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || '');
  }

  // Log útil para depurar em Netlify → Functions → Logs
  console.log('Proxy →', { from: event.path, to: target });

  const upstream = await fetch(target, init);
  const arrayBuf = await upstream.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  const ct = upstream.headers.get('content-type') || 'application/octet-stream';
  const isTextLike = /^text\/|application\/(json|javascript)/i.test(ct);
  const cd = upstream.headers.get('content-disposition');
  const cacheControl = upstream.headers.get('cache-control');

  const respHeaders = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': ORIGIN,
    'Vary': 'Origin'
  };
  if (cd) respHeaders['Content-Disposition'] = cd;
  if (cacheControl) respHeaders['Cache-Control'] = cacheControl;

  return {
    statusCode: upstream.status,
    headers: respHeaders,
    body: isTextLike ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isTextLike
  };
}
