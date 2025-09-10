// Serverless Function no Netlify que injeta X-API-Key e repassa ao Render
export async function handler(event) {
  const origin = event.headers.origin || '';

  // CORS p/ preflight (normalmente será same-origin)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Cache-Control,X-Idempotency-Key',
        'Vary': 'Origin'
      }
    };
  }

  const API_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com').replace(/\/+$/,'');
  const subpath = event.path.replace('/.netlify/functions/api-proxy',''); // ex: "/consulta"
  const qs = event.rawQuery ? `?${event.rawQuery}` : '';
  const target = `${API_BASE}/api${subpath}${qs}`;

  // Copia alguns headers úteis do cliente
  const pass = {};
  for (const [k,v] of Object.entries(event.headers||{})) {
    const lk = k.toLowerCase();
    if (['content-type','cache-control','x-idempotency-key'].includes(lk)) pass[k] = v;
  }
  // Injeta a API key do servidor (não vai para o cliente)
  pass['X-API-Key'] = process.env.API_KEY;

  const res = await fetch(target, {
    method: event.httpMethod,
    headers: pass,
    body: ['GET','HEAD','OPTIONS'].includes(event.httpMethod) ? undefined : event.body
  });

  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const isBinary = !/^text\/|application\/(json|javascript)/i.test(ct);

  // repassa Content-Disposition para download de PDF
  const outHeaders = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin'
  };
  const cd = res.headers.get('content-disposition');
  if (cd) outHeaders['Content-Disposition'] = cd;

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: isBinary ? buf.toString('base64') : buf.toString('utf8'),
    isBase64Encoded: isBinary
  };
}
