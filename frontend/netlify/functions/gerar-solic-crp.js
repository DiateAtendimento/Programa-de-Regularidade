// netlify/functions/gerar-solic-crp.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    let data = body?.data ?? body ?? {};

    // Valida com seu schema (ESM)
    try {
      const mod = await import('../../schemaSolicCrp.js');
      if (mod && mod.schemaSolicCrp) {
        const res = mod.schemaSolicCrp.safeParse(data);
        if (!res.success) {
          return {
            statusCode: 422,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok:false, errors: res.error.flatten() })
          };
        }
        data = res.data;
      }
    } catch { /* sem schema, segue */ }

    // Aqui você pode salvar em planilha, banco etc.
    console.log('Solicitação CRP recebida:', {
      ENTE: data.ENTE, UF: data.UF, FASE: data.FASE_PROGRAMA, IDEMP_KEY: data.IDEMP_KEY
    });

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'Erro ao registrar solicitação' };
  }
};
