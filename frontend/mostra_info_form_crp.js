
/**
 * Garante que todos os campos da fase 4.3 (4.3.1 a 4.3.12) cheguem ao payload
 * usado para gerar o PDF. Ele normaliza listas, preenche aliases e força o
 * envio para o template termo_solic_crp.html.
 */
(() => {
  const asArr = (v) => {
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === 'string') {
      const parts = v.split(/[,;]\s*|\n+/).map(s => s.trim()).filter(Boolean);
      return parts.length ? parts : (v.trim() ? [v.trim()] : []);
    }
    return v ? [v] : [];
  };
  const setList = (payload, key, val) => {
    const arr = asArr(val);
    if (!arr.length) return;
    payload[key] = arr;
    payload[`${key}[]`] = arr.slice();
    payload[`${key}_TXT`] = arr.join('; ');
  };
  const getFromStore = (k) => {
    try {
      const st = JSON.parse(localStorage.getItem('solic-crp-form-v1') || '{}');
      const vals = st.values || {};
      return vals[k] ?? vals[`${k}[]`] ?? '';
    } catch { return ''; }
  };

  function mergeF43(payload = {}) {
    // 4.3.1–4.3.9 (lista principal)
    setList(payload, 'F43_LISTA', payload.F43_LISTA || payload['F43_LISTA[]'] || payload.F43_ITENS || payload['F43_ITENS[]'] || getFromStore('F43_LISTA') || getFromStore('F43_ITENS'));

    // 4.3.10
    payload.F4310_OPCAO = payload.F4310_OPCAO || getFromStore('F4310_OPCAO') || '';
    payload.F4310_LEGISLACAO = payload.F4310_LEGISLACAO || getFromStore('F4310_LEGISLACAO') || '';
    payload.F4310_DOCS = payload.F4310_DOCS || getFromStore('F4310_DOCS') || '';

    // 4.3.11
    setList(payload, 'F43_INCLUIR', payload.F43_INCLUIR || payload['F43_INCLUIR[]'] || getFromStore('F43_INCLUIR'));
    payload.F43_PLANO = payload.F43_PLANO || getFromStore('F43_PLANO') || '';

    // 4.3.12
    setList(payload, 'F43_INCLUIR_B', payload.F43_INCLUIR_B || payload['F43_INCLUIR_B[]'] || getFromStore('F43_INCLUIR_B'));
    payload.F43_PLANO_B = payload.F43_PLANO_B || getFromStore('F43_PLANO_B') || '';
    payload.F43_DESC_PLANOS = payload.F43_DESC_PLANOS || getFromStore('F43_DESC_PLANOS') || '';

    // Garantias finais de texto
    payload.F43_LISTA_TXT = payload.F43_LISTA_TXT || (Array.isArray(payload.F43_LISTA) ? payload.F43_LISTA.join('; ') : '');
    payload.F4311_INCLUIR_TXT = payload.F4311_INCLUIR_TXT || (Array.isArray(payload.F43_INCLUIR) ? payload.F43_INCLUIR.join('; ') : payload.F43_INCLUIR || '');
    payload.F4312_INCLUIR_TXT = payload.F4312_INCLUIR_TXT || (Array.isArray(payload.F43_INCLUIR_B) ? payload.F43_INCLUIR_B.join('; ') : payload.F43_INCLUIR_B || '');
    payload.F4312_DESC_TXT = payload.F4312_DESC_TXT || payload.F43_DESC_PLANOS || '';

    return payload;
  }

  // Monkey patch: garante que o payload seja corrigido antes de ir para o PDF
  const origGerar = window.gerarBaixarPDF;
  if (typeof origGerar === 'function') {
    window.gerarBaixarPDF = async function (p) {
      return origGerar.call(this, mergeF43(p || {}));
    };
  }

  // Também força quando o template termo_solic_crp.html rodar window.run(payload)
  const origRun = window.run;
  if (typeof origRun === 'function') {
    window.run = function (p) {
      return origRun.call(this, mergeF43(p || {}));
    };
  }

  // Expor para debug manual
  window.__mostraInfoFormCRP__ = { mergeF43 };
})();

