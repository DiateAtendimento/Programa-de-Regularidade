// Netlify Function que encaminha p/ Render injetando a API key
export async function handler(event) {
  const origin = event.headers?.origin || '*';

  // --- CORS / preflight ---
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Cache-Control,X-Idempotency-Key,X-API-Key,Authorization',
        Vary: 'Origin'
      }
    };
  }

  // --- Config ---
  const API_BASE = (process.env.API_BASE || 'https://programa-de-regularidade.onrender.com').replace(/\/+$/, '');
  const API_KEY  = process.env.API_KEY; // ex: fprpps_5uP3rL0ng_
  if (!API_KEY) {
    return respJSON(500, { error: 'API_KEY não definida no ambiente do Netlify.' }, origin);
  }

  // --- Normaliza subpath (aceita /_api/... e /.netlify/functions/api-proxy/...) ---
  const url = new URL(event.rawUrl);
  let subpath = url.pathname;
  for (const base of ['/.netlify/functions/api-prox', '/.netlify/functions/api-proxy', '/_api']) {
    if (subpath.startsWith(base)) { subpath = subpath.slice(base.length); break; }
  }
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  // --- Rotas utilitárias locais ---
  if (subpath === '/health') return respJSON(200, { ok: true }, origin);
  if (subpath === '/_diag') {
    return respJSON(200, {
      hasApiKey: !!API_KEY,
      apiKeyLen: API_KEY.length,
      apiBase: API_BASE
    }, '*');
  }

  // Probe: dispara /api/consulta no Render e te mostra o status lá de trás
  if (subpath === '/_probe') {
    const cnpj = (url.searchParams.get('cnpj') || '').replace(/\D+/g, '');
    if (cnpj.length !== 14) return respJSON(400, { error: 'Informe ?cnpj=14 dígitos' }, origin);
    const probeURL = `${API_BASE}/api/consulta?cnpj=${cnpj}`;

    const h = new Headers();
    h.set('X-API-Key', API_KEY);
    h.set('Accept', 'application/json');

    const r = await fetch(probeURL, { method: 'GET', headers: h });
    const txt = await r.text().catch(() => '');
    return respJSON(200, {
      upstream: probeURL,
      sentHeaders: { 'X-API-Key': `***${API_KEY.slice(-4)}`, 'Accept': 'application/json' },
      upstreamStatus: r.status,
      upstreamCT: r.headers.get('content-type') || '',
      sample: txt.slice(0, 300) // um pedacinho só
    }, origin);
  }

  // --- Monta destino no Render (sempre preprend /api) ---
  const target = `${API_BASE}/api${subpath}${url.search || ''}`;

  // --- Cabeçalhos a repassar + injeção da chave ---
  const h = new Headers();
  // repasse leve
  const src = event.headers || {};
  if (src['content-type'])     h.set('Content-Type', src['content-type']);
  if (src['cache-control'])    h.set('Cache-Control', src['cache-control']);
  if (src['x-idempotency-key'])h.set('X-Idempotency-Key', src['x-idempotency-key']);
  h.set('Accept', 'application/json');

  // ✅ injeção da credencial (APENAS esse header, para evitar qualquer conflito)
  h.set('X-API-Key', API_KEY);

  // --- Encaminha ---
  const res = await fetch(target, {
    method: event.httpMethod,
    headers: h,
    body: (event.httpMethod === 'GET' || event.httpMethod === 'HEAD') ? undefined : event.body
  });

  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const isText = /^text\/|application\/(json|javascript)/i.test(ct);

  const outHeaders = { 'Content-Type': ct, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const cd = res.headers.get('content-disposition');
  if (cd) outHeaders['Content-Disposition'] = cd;

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: isText ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isText
  };
}

function respJSON(status, obj, origin='*') {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin, Vary: 'Origin' },
    body: JSON.stringify(obj)
  };
}
