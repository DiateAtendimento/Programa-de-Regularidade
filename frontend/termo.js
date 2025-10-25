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
    const mISO = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (mISO) return `${mISO[3]}/${mISO[2]}/${mISO[1]}`;
    return s; // se já vier dd/mm/aaaa, mantém
  };

  const setTextAll = (k, v) => {
    const text = (v == null || String(v).trim() === '') ? '' : v;
    document.querySelectorAll(`[data-k="${k}"]`).forEach(el => el.textContent = text);
  };

  const NOT_INFORMED = '<em>Não informado</em>';

  // ===== util para filtrar listas por códigos =====
  function filterBy(listId, codes){
    const list = document.getElementById(listId);
    if (!list) return;
    const items = [...list.querySelectorAll('li')];
    if (!codes.length){
      items.forEach(li => li.remove());
      const li = document.createElement('li'); li.innerHTML = NOT_INFORMED; list.appendChild(li);
      return;
    }
    items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
  }

  // ========= Render principal =========
  function renderizarTermo(p){
    // ——— Campos DIRETOS (Etapas 1–2)
    setTextAll('uf',          p.UF || '');
    setTextAll('ente',        p.ENTE || '');
    setTextAll('cnpj_ente',   fmtCNPJ(p.CNPJ_ENTE || ''));
    setTextAll('email_ente',  p.EMAIL_ENTE || '');
    setTextAll('ug',          p.UG || '');
    setTextAll('cnpj_ug',     fmtCNPJ(p.CNPJ_UG || ''));
    setTextAll('email_ug',    p.EMAIL_UG || '');

    setTextAll('nome_rep_ente',  p.NOME_REP_ENTE || '');
    setTextAll('cargo_rep_ente', p.CARGO_REP_ENTE || '');
    setTextAll('cpf_rep_ente',   fmtCPF(p.CPF_REP_ENTE || ''));
    setTextAll('email_rep_ente', p.EMAIL_REP_ENTE || '');

    setTextAll('nome_rep_ug',  p.NOME_REP_UG || '');
    setTextAll('cargo_rep_ug', p.CARGO_REP_UG || '');
    setTextAll('cpf_rep_ug',   fmtCPF(p.CPF_REP_UG || ''));
    setTextAll('email_rep_ug', p.EMAIL_REP_UG || '');

    // Data do termo (registro)
    setTextAll('data_termo', fmtDataBR(p.DATA_TERMO_GERADO || ''));

    // ===== Etapa 3 – CRP (campos diretos, com compat) =====
    setTextAll('crp_venc', fmtDataBR(p.DATA_VENCIMENTO_ULTIMO_CRP || p.crp_venc || ''));
    setTextAll('crp_tipo', (p.TIPO_EMISSAO_ULTIMO_CRP || p.crp_tipo || '').trim());
    (function applyPrazoAdicional(){
      const el = document.querySelector('[data-k="prazo_adicional_flag"]');
      if (!el) return;
      const raw = String(p.PRAZO_ADICIONAL_FLAG || p.prazo_adicional_flag || '').trim().toUpperCase();
      if (raw === 'SIM' || raw === 'NÃO' || raw === 'NAO') {
        el.textContent = (raw === 'NAO') ? 'NÃO' : raw;
      } else {
        el.textContent = 'Não informado';
      }
    })();

    // ===== 1.1 – Esfera de Governo =====
    (function(){
      const list = document.getElementById('opt-1-1');
      if (!list) return;

      // preferência: p.ESFERA_COD; fallback heurístico textual
      let esferaCod = String(p.ESFERA_COD || '').trim();
      if (!esferaCod) {
        let esfera = '';
        const rawEsfera = String(p.ESFERA || '').toLowerCase();
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

    // ===== Etapa 3.3 – Critérios irregulares =====
    (function () {
      const list = document.getElementById('criterios-list');
      if (!list) return;

      const raw = p.CRITERIOS_IRREGULARES;
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

    // ===== Etapa 3.5 – Adesão sem irregularidades =====
    (function(){
      const box = document.getElementById('blk-3-2-adesao');
      const ul  = document.getElementById('finalidades-3-2');
      if (!box || !ul) return;

      const flag = String(p.ADESAO_SEM_IRREGULARIDADES || '').trim().toUpperCase();
      const isYes = (flag === 'SIM' || flag === 'TRUE' || flag === '1' || flag === 'ON' || flag === 'X');

      if (!isYes) {
        ul.innerHTML = `<li>${NOT_INFORMED}</li>`;
        return;
      }

      box.style.removeProperty('display');
      ul.innerHTML = `
        <li>
          O RPPS <strong>não apresenta, atualmente, irregularidades</strong> nos critérios do extrato previdenciário,
          mas necessita de prazo adicional para:
        </li>`;
    })();

    // ===== Util p/ pegar só códigos de uma seção a partir de p.SELECTED_CODES =====
    const wantCodes = (prefix) => {
      const src = Array.isArray(p.SELECTED_CODES) ? p.SELECTED_CODES : [];
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

    // re-hidrata spans usados nas assinaturas
    setTextAll('ente', p.ENTE || '');
    setTextAll('uf',   p.UF   || '');

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
    renderizarTermo(window.__TERMO_DATA__ || {});
  });

  // ========= Fallback: querystring (para testes) =========
  document.addEventListener('DOMContentLoaded', () => {
    if (window.__TERMO_DATA__) { renderizarTermo(window.__TERMO_DATA__ || {}); return; }
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
        ESFERA_COD: q.get('esfera_cod') || ''
      };
      renderizarTermo(payload);
    }
  });
})();
