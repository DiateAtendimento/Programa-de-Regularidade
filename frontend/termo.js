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

    setTextAll('nome_rep_ente',  p.NOME_REP_ENTE || p.nome_rep_ente || '');
    setTextAll('cargo_rep_ente', p.CARGO_REP_ENTE || p.cargo_rep_ente || '');
    setTextAll('cpf_rep_ente',   fmtCPF(p.CPF_REP_ENTE || p.cpf_rep_ente || ''));
    setTextAll('email_rep_ente', p.EMAIL_REP_ENTE || p.email_rep_ente || '');

    setTextAll('nome_rep_ug',  p.NOME_REP_UG || p.nome_rep_ug || '');
    setTextAll('cargo_rep_ug', p.CARGO_REP_UG || p.cargo_rep_ug || '');
    setTextAll('cpf_rep_ug',   fmtCPF(p.CPF_REP_UG || p.cpf_rep_ug || ''));
    setTextAll('email_rep_ug', p.EMAIL_REP_UG || p.email_rep_ug || '');

    // ORGAO DE VINCULAÇÃO da UG (se existir no payload)
    setTextAll('orgao_vinculacao_ug', p.ORGAO_VINCULACAO_UG || p.orgao_vinculacao_ug || '');

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

    // 3.2 Tipo de emissão do último CRP (Sim→Judicial / Não→Administrativa)
    let crpTipo = (p.TIPO_EMISSAO_ULTIMO_CRP || p.TIPO_EMISSAO || p.crp_tipo || '').trim();
    if (!crpTipo) {
      const raw = String(p.CRP_DECISAO_JUDICIAL || p.DECISAO_JUDICIAL || p.DEC_JUDICIAL || p.CRP_DJ || '').toLowerCase();
      if (raw.includes('sim') || raw.includes('s')) crpTipo = 'Judicial';
      else if (raw.includes('nao') || raw.includes('não') || raw.includes('n')) crpTipo = 'Administrativa';
      else {
        // também checar flags booleanas que possam existir
        if (p.em_jud === true || String(p.em_jud) === 'true') crpTipo = 'Judicial';
        else if (p.em_adm === true || String(p.em_adm) === 'true') crpTipo = 'Administrativa';
      }
    }
    setTextAll('crp_tipo', crpTipo || '');

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

      // várias chaves possíveis para a flag
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

      // Se flag estiver vazia → mostramos "Não informado"; senão mostramos SIM/NÃO
      elFlag.textContent = flagOut || 'Não informado';
    })();

    // ===== 1.1 – Esfera de Governo =====
    (function(){
      const list = document.getElementById('opt-1-1');
      if (!list) return;

      // preferência: p.ESFERA_COD; fallback heurístico textual
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

      // legenda da assinatura
      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        sig.innerHTML = (esferaCod === '1.1.2')
          ? 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>'
          : 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
      }
    })();

    // ===== Util p/ pegar só códigos de uma seção a partir de p.SELECTED_CODES =====
    const wantCodes = (prefix) => {
      const src = Array.isArray(p.SELECTED_CODES) ? p.SELECTED_CODES : (String(p.SELECTED_CODES || '') ? String(p.SELECTED_CODES).split(',').map(s=>s.trim()).filter(Boolean) : []);
      return src.filter(c => String(c || '').startsWith(prefix));
    };

    // ===== Etapa 4 – FINALIDADES (preferindo SELECTED_CODES) =====
    filterBy('opt-4-1', wantCodes('4.1'));
    filterBy('opt-4-2', wantCodes('4.2'));
    filterBy('opt-4-3', wantCodes('4.3'));
    filterBy('opt-4-4', wantCodes('4.4'));
    filterBy('opt-4-5', wantCodes('4.5'));
    filterBy('opt-4-6', wantCodes('4.6'));

    // ===== Etapa 5 – Compromissos (5.1 a 5.8) =====
    filterBy('opt-5', wantCodes('5.'));

    // ===== Etapa 6 – Providências (6.1/6.2) =====
    filterBy('opt-6', wantCodes('6.'));

    // ===== Etapa 7 – Condições (7.1–7.4) =====
    filterBy('opt-7', wantCodes('7.'));

    // re-hidrata spans usados nas assinaturas (garantia)
    setTextAll('ente', p.ENTE || p.ente || '');
    setTextAll('uf',   p.UF   || p.uf   || '');

    // 🔔 sinaliza “pronto para imprimir”
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

  // ========= Fluxo 1: Preview (postMessage) =========
  window.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg || msg.type !== 'TERMO_PREVIEW_DATA') return;
    const p = msg.payload || {};
    if (!p || (typeof p !== 'object')) return;
    try { renderizarTermo(p); }
    catch (e) { console.error('[TERMO_PREVIEW_DATA] render error:', e); }
  }, false);

  // ========= Fluxo 2: PDF (Puppeteer) =========
  document.addEventListener('TERMO_DATA_READY', () => {
    try { renderizarTermo(window.__TERMO_DATA__ || {}); } catch (e) { console.error('[TERMO_DATA_READY] render error:', e); }
  });

  // ========= Fallback: querystring (para testes) =========
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

        // Etapa 3
        CRITERIOS_IRREGULARES: (()=>{
          const multi = q.getAll('criterio'); if (multi && multi.length) return multi;
          const joined = q.get('criterios') || ''; return joined ? joined.split(/[;,]/).map(s=>s.trim()).filter(Boolean) : [];
        })(),
        ADESAO_SEM_IRREGULARIDADES: q.get('adesao_sem_irregularidades') || '',
        OUTRO_CRITERIO_COMPLEXO: q.get('outro_criterio_complexo') || '',

        // Etapa 4 (fallback)
        SELECTED_CODES: (q.get('codes') || '').split(',').map(s=>s.trim()).filter(Boolean),

        // Etapa 5–7 (texto)
        COMPROMISSO_FIRMADO_ADESAO: q.get('compromissos') || q.get('compromisso') || '',
        PROVIDENCIA_NECESS_ADESAO: q.get('providencias') || '',
        CONDICAO_VIGENCIA: q.get('condicao_vigencia') || '',

        // Registro
        DATA_TERMO_GERADO: q.get('data_termo') || '',
        ESFERA_COD: q.get('esfera_cod') || '',

        // prazo adicional (fallbacks)
        PRAZO_ADICIONAL_FLAG: q.get('prazo_adicional_flag') || ''
      };
      try { renderizarTermo(payload); } catch (e) { console.error('[TERMO_QS] render error:', e); }
    }
  });
})();
