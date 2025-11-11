

(() => {
  'use strict';

  // ========= Helpers =========
  const digits = v => String(v || '').replace(/\D+/g, '');

  const fmtCPF  = v => {
    const d = digits(v);
    return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : (v || '');
  };

  const fmtCNPJ = v => {
    const d = digits(v);
    return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : (v || '');
  };

  // aceita 'aaaa-mm-dd' e 'aaaa-mm-ddTHH:MM:SS...' e mantém dd/mm/aaaa
  const fmtDataBR = v => {
    const s = String(v || '').trim();
    if (!s) return '';
    const mISO = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (mISO) return `${mISO[3]}/${mISO[2]}/${mISO[1]}`;
    // tenta interpretar como Date (ex.: '2025-10-26T11:46:00.000Z')
    const maybeDate = new Date(s);
    if (!isNaN(maybeDate.getTime())) {
      return maybeDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }
    return s; // se já vier dd/mm/aaaa, mantém
  };

  // data de hoje em pt-BR (fuso São Paulo)
  const todayBR = () =>
    new Date().toLocaleDateString('pt-BR', { timeZone:'America/Sao_Paulo' });

  const setTextAll = (k, v) => {
    const text = (v == null || String(v).trim() === '') ? '' : String(v);
    document.querySelectorAll(`[data-k="${k}"]`).forEach(el => el.textContent = text);
  };

  // pega o primeiro valor "preenchido" dentre várias chaves (upper/lower/aliases)
  const get = (obj, ...keys) => {
    for (const k of keys) {
      const v = obj != null ? obj[k] : undefined;
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
  };

  const NOT_INFORMED = '<em>Não informado</em>';

  // ===== util para filtrar listas por códigos =====
  function filterBy(listId, codes){
    const list = document.getElementById(listId);
    if (!list) return;
    const items = [...list.querySelectorAll('li')];
    if (!codes || !codes.length){
      // limpa e coloca "Não informado"
      list.innerHTML = '';
      const li = document.createElement('li'); li.innerHTML = NOT_INFORMED; list.appendChild(li);
      return;
    }
    items.forEach(li => {
      const code = li.getAttribute('data-code');
      if (!codes.includes(code)) li.remove();
    });
  }

  // ========= Render principal =========
  function renderizarTermo(p){
    if (!p || typeof p !== 'object') p = {};

    // ——— Campos DIRETOS (Etapas 1–2)
    setTextAll('uf',          p.UF || p.uf || '');
    setTextAll('ente',        p.ENTE || p.ente || '');
    setTextAll('cnpj_ente',   fmtCNPJ(p.CNPJ_ENTE || p.cnpj_ente || ''));
    setTextAll('email_ente',  p.EMAIL_ENTE || p.email_ente || '');
    setTextAll('ug',          p.UG || p.ug || '');
    setTextAll('cnpj_ug',     fmtCNPJ(p.CNPJ_UG || p.cnpj_ug || ''));
    setTextAll('email_ug',    p.EMAIL_UG || p.email_ug || '');
    // 3.1 Data de vencimento do último CRP (mostra formatada)
    const rawVencUlt = get(
      p,
      'CRP_DATA_VALIDADE_ISO', 'CRP_DATA_VALIDADE_DMY',
      'DATA_VENCIMENTO_ULTIMO_CRP', 'DATA_VENC_ULTIMO_CRP',
      'data_vencimento_ultimo_crp', 'data_venc_ultimo_crp', 'venc_ult_crp'
    );
    setTextAll('data_vencimento_ultimo_crp', rawVencUlt ? fmtDataBR(rawVencUlt) : '');

    // Órgão de Vinculação (UG)
    setTextAll('ORGAO_VINCULACAO_UG', get(
      p,
      'ORGAO_VINCULACAO_UG', 'orgao_vinculacao_ug', 'ug_orgao_vinc', 'ORGAO_VINC'
    ));

    setTextAll('nome_rep_ente',  p.NOME_REP_ENTE || p.nome_rep_ente || '');
    setTextAll('cargo_rep_ente', p.CARGO_REP_ENTE || p.cargo_rep_ente || '');
    setTextAll('cpf_rep_ente',   fmtCPF(p.CPF_REP_ENTE || p.cpf_rep_ente || ''));
    setTextAll('email_rep_ente', p.EMAIL_REP_ENTE || p.email_rep_ente || '');

    setTextAll('nome_rep_ug',  p.NOME_REP_UG || p.nome_rep_ug || '');
    setTextAll('cargo_rep_ug', p.CARGO_REP_UG || p.cargo_rep_ug || '');
    setTextAll('cpf_rep_ug',   fmtCPF(p.CPF_REP_UG || p.cpf_rep_ug || ''));
    setTextAll('email_rep_ug', p.EMAIL_REP_UG || p.email_rep_ug || '');

    // ORGAO DE VINCULAÇÃO da UG (espelha para ambos data-k usados no HTML)
    const orgVincUG = get(p, 'ORGAO_VINCULACAO_UG', 'orgao_vinculacao_ug', 'ug_orgao_vinc', 'ORGAO_VINC');
    setTextAll('orgao_vinculacao_ug', orgVincUG);

    // Data do termo (registro) — com fallback para hoje
    const dataTermoRaw = p.DATA_TERMO_GERADO || p.DATA_TERMO || p.data_termo || '';
    const dataTermo = dataTermoRaw ? fmtDataBR(dataTermoRaw) : todayBR();
    setTextAll('data_termo', dataTermo);

    // 3.1 Data de vencimento do último CRP (preferindo DATA_SITUACAO da aba CRP)
    const crpVenc =
      p.CRP_DATA_SITUACAO_ISO || p.CRP_DATA_SITUACAO_DMY || p.CRP_DATA_SITUACAO ||
      p.DATA_SITUACAO_ISO     || p.DATA_SITUACAO         || p.DATA_SUTUACAO ||
      p.DATA_VENCIMENTO_ULTIMO_CRP ||
      p.CRP_DATA_VALIDADE_ISO || p.CRP_DATA_VALIDADE_DMY || '';
    setTextAll('crp_venc', crpVenc ? fmtDataBR(crpVenc) : '');

    // 3.2 Tipo de emissão do último CRP (inferência robusta)
    let crpTipo = (get(p, 'TIPO_EMISSAO_ULTIMO_CRP', 'TIPO_EMISSAO', 'crp_tipo') || '').trim();
    if (!crpTipo) {
      const raw = String(p.CRP_DECISAO_JUDICIAL || p.DECISAO_JUDICIAL || p.DEC_JUDICIAL || p.CRP_DJ || '').toLowerCase();
      const hasValidade =
        !!(p.CRP_DATA_VALIDADE_ISO || p.CRP_DATA_VALIDADE_DMY ||
           p.CRP_DATA_SITUACAO_ISO || p.CRP_DATA_SITUACAO_DMY ||
           p.DATA_VENCIMENTO_ULTIMO_CRP);

      if (raw.includes('sim') || raw.includes('s')) crpTipo = 'Judicial';
      else if (raw.includes('nao') || raw.includes('não') || raw.includes('n')) crpTipo = 'Administrativa';
      else if (hasValidade) crpTipo = 'Administrativa';
      else {
        // fallback para flags booleanas (compat)
        if (p.em_jud === true || String(p.em_jud) === 'true') crpTipo = 'Judicial';
        else if (p.em_adm === true || String(p.em_adm) === 'true') crpTipo = 'Administrativa';
      }
    }
    setTextAll('crp_tipo', crpTipo || '');
    
    // mantém data-k legado se existir no template
    setTextAll('tipo_emissao_ult_crp', crpTipo || '');

    // 3.3 Critérios irregulares (pode vir como string separada por ';' ou array)
    (function () {
      const list = document.getElementById('criterios-list');
      if (!list) return;

      const raw = p.CRITERIOS_IRREGULARES || p.CRITERIOS || p.criterios || '';
      const arr = Array.isArray(raw)
        ? raw
        : String(raw || '')
            .split(/[;,]/)
            .map(s => s.trim())
            .filter(Boolean);

      list.innerHTML = '';

      if (!arr.length) {
        const li = document.createElement('li');
        li.innerHTML = NOT_INFORMED;
        list.appendChild(li);
        return;
      }

      arr.forEach(v => {
        const li = document.createElement('li');
        li.textContent = v;
        list.appendChild(li);
      });
    })();

    // 3.4 Solicitação de Prazo Adicional — apenas exibe a FLAG (SIM / NÃO / Não informado)
    (function applyPrazoAdicional(){
      const elFlag = document.querySelector('[data-k="prazo_adicional_flag"]');
      if (!elFlag) return;

      const rawFlag = String(
        p.PRAZO_ADICIONAL_FLAG ||
        p.PRAZO_ADICIONAL ||
        p.PRAZO_ADICIONAL_SOLICITADO ||
        p.prazo_adicional_flag ||
        p.prazo_adicional ||
        ''
      ).trim().toUpperCase();

      let flagOut = '';
      if (rawFlag === 'SIM' || rawFlag === 'S' || rawFlag === 'TRUE' || rawFlag === '1') flagOut = 'SIM';
      else if (rawFlag === 'NAO' || rawFlag === 'N' || rawFlag === 'NÃO' || rawFlag === 'FALSE' || rawFlag === '0') flagOut = 'NÃO';
      else flagOut = (rawFlag ? rawFlag : '');

      elFlag.textContent = flagOut || 'Não informado';
    })();

    // Ajuste da legenda da segunda assinatura (UG)
    (function adjustSecondSignatureCaption(){
      try {
        const blocks = Array.from(document.querySelectorAll('.signature-block'));
        if (!blocks || blocks.length < 2) return;
        const second = blocks[1];
        const caption = second.querySelector('.signature-caption');
        if (!caption) return;

        const ugName = String(p.UG || p.ug || '').trim();
        const esferaRaw = String(p.ESFERA || p.esfera || p.ESFERA_COD || '').toLowerCase();
        const esferaCod = String(p.ESFERA_COD || '').trim();

        const isMunicipal =
          /municipal/.test(esferaRaw) || esferaCod === '1.1.1';

        if (isMunicipal || /institut/i.test(ugName)) {
          caption.innerHTML =
            `<strong><span data-k="nome_rep_ug"></span></strong><br>` +
            `Representante legal do Instituto de Previdência do Município de ` +
            `<span data-k="ente"></span>/<span data-k="uf"></span>`;
        } else {
          caption.innerHTML =
            `<strong><span data-k="nome_rep_ug"></span></strong><br>` +
            `Representante legal do <span data-k="ug"></span>`;
        }
      } catch (_) {}
    })();


    // ===== 1.1 – Esfera de Governo =====
    (function(){
      const list = document.getElementById('opt-1-1');
      if (!list) return;

      let esferaCod = String(p.ESFERA_COD || p.ESFERA || '').trim();
      if (!esferaCod) {
        let esfera = '';
        const rawEsfera = String(p.ESFERA || p.esfera || '').toLowerCase();
        if (/municipal/.test(rawEsfera)) esfera = 'municipal';
        else if (/estadual|distrital/.test(rawEsfera)) esfera = 'estadual';

        if (!esfera) {
          const ente = String(p.ENTE || '').toLowerCase();
          esfera = /estado|distrito/.test(ente) ? 'estadual' : 'municipal';
        }
        esferaCod = (esfera === 'estadual') ? '1.1.2' : '1.1.1';
      }

      const items = [...list.querySelectorAll('li')];
      items.forEach(li => { if (li.getAttribute('data-code') !== esferaCod) li.remove(); });

      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        sig.innerHTML = (esferaCod === '1.1.2')
          ? 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>'
          : 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
      }
    })();

    // util para códigos
    const wantCodes = (prefix) => {
      const src = Array.isArray(p.SELECTED_CODES) ? p.SELECTED_CODES : (String(p.SELECTED_CODES || '') ? String(p.SELECTED_CODES).split(',').map(s=>s.trim()).filter(Boolean) : []);
      return src.filter(c => String(c || '').startsWith(prefix));
    };

    // Finalidades / Compromissos / Providências / Condições
    filterBy('opt-4-1', wantCodes('4.1'));
    filterBy('opt-4-2', wantCodes('4.2'));
    filterBy('opt-4-3', wantCodes('4.3'));
    filterBy('opt-4-4', wantCodes('4.4'));
    filterBy('opt-4-5', wantCodes('4.5'));
    filterBy('opt-4-6', wantCodes('4.6'));

    filterBy('opt-5', wantCodes('5.'));
    filterBy('opt-6', wantCodes('6.'));
    filterBy('opt-7', wantCodes('7.'));

    // re-hidrata spans usados nas assinaturas (garantia)
    setTextAll('ente', p.ENTE || p.ente || '');
    setTextAll('uf',   p.UF   || p.uf   || '');

    // sinaliza “pronto para imprimir”
    try {
      if (!window.__TERMO_READY_FIRED__) {
        window.__TERMO_READY_FIRED__ = true;
        const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        fontsReady.finally(() => {
          requestAnimationFrame(() => {
            window.__TERMO_PRINT_READY__ = true;
            document.dispatchEvent(new CustomEvent('TERMO_PRINT_READY'));
          });
        });
      }
    } catch (_) {}
  }

  // Fluxo: preview via postMessage
  window.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg || msg.type !== 'TERMO_PREVIEW_DATA') return;
    const p = msg.payload || {};
    if (!p || (typeof p !== 'object')) return;
    try { renderizarTermo(p); }
    catch (e) { console.error('[TERMO_PREVIEW_DATA] render error:', e); }
  }, false);

  // Fluxo: PDF (Puppeteer) — quando backend injeta window.__TERMO_DATA__
  document.addEventListener('TERMO_DATA_READY', () => {
    try { renderizarTermo(window.__TERMO_DATA__ || {}); } catch (e) { console.error('[TERMO_DATA_READY] render error:', e); }
  });

  // Fallback: querystring (apenas para testes). NÃO inclui justificativa do prazo adicional.
  document.addEventListener('DOMContentLoaded', () => {
    if (window.__TERMO_DATA__) { try { renderizarTermo(window.__TERMO_DATA__ || {}); } catch (e) { console.error('[TERMO_INIT] render error:', e); } return; }
    const q = new URLSearchParams(location.search);
    if (q.has('uf') || q.has('ente')) {
      const payload = {
        UF: q.get('uf') || '', ENTE: q.get('ente') || '',
        CNPJ_ENTE: q.get('cnpj_ente') || '', EMAIL_ENTE: q.get('email_ente') || '',
        UG: q.get('ug') || '', CNPJ_UG: q.get('cnpj_ug') || '', EMAIL_UG: q.get('email_ug') || '',

        NOME_REP_ENTE: q.get('nome_rep_ente') || '', CPF_REP_ENTE: q.get('cpf_rep_ente') || '',
        CARGO_REP_ENTE: q.get('cargo_rep_ente') || '', EMAIL_REP_ENTE: q.get('email_rep_ente') || '',

        NOME_REP_UG: q.get('nome_rep_ug') || '', CPF_REP_UG: q.get('cpf_rep_ug') || '',
        CARGO_REP_UG: q.get('cargo_rep_ug') || '', EMAIL_REP_UG: q.get('email_rep_ug') || '',

        CRITERIOS_IRREGULARES: (function(){
          const list = [];
          // aceita criterio, criterio[], criterios, criterios[]
          list.push(...q.getAll('criterio'));
          list.push(...q.getAll('criterio[]'));
          const joined = q.get('criterios') || '';
          if (joined) list.push(...joined.split(/[;,]/).map(s=>s.trim()).filter(Boolean));
          list.push(...q.getAll('criterios[]'));
          return list.filter(Boolean);
        })(),

        ADESAO_SEM_IRREGULARIDADES: q.get('adesao_sem_irregularidades') || '',
        OUTRO_CRITERIO_COMPLEXO: q.get('outro_criterio_complexo') || '',

        SELECTED_CODES: (q.get('codes') || '').split(',').map(s=>s.trim()).filter(Boolean),

        COMPROMISSO_FIRMADO_ADESAO: q.get('compromissos') || q.get('compromisso') || '',
        PROVIDENCIA_NECESS_ADESAO: q.get('providencias') || '',
        CONDICAO_VIGENCIA: q.get('condicao_vigencia') || '',

        DATA_TERMO_GERADO: q.get('data_termo') || '',
        ESFERA_COD: q.get('esfera_cod') || '',

        // apenas a flag do prazo adicional (se fornecida via QS)
        PRAZO_ADICIONAL_FLAG: q.get('prazo_adicional_flag') || '',

        // inclusões QS para 3.1 / 3.2 e órgão de vinculação (UG)
        DATA_VENCIMENTO_ULTIMO_CRP: q.get('data_vencimento_ultimo_crp') || q.get('data_venc_ultimo_crp') || q.get('venc_ult_crp') || '',
        TIPO_EMISSAO_ULTIMO_CRP: q.get('tipo_emissao_ult_crp') || q.get('crp_tipo') || '',
        ORGAO_VINCULACAO_UG: q.get('orgao_vinculacao_ug') || q.get('ORGAO_VINCULACAO_UG') || q.get('ug_orgao_vinc') || q.get('orgao_vinc') || ''
       
      };
      try { renderizarTermo(payload); } catch (e) { console.error('[TERMO_QS] render error:', e); }
    }
  });
})();