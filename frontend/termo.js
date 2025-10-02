(() => {
  'use strict';

  // ========= Helpers =========
  const digits = v => String(v || '').replace(/\D+/g, '');

  const fmtCPF  = v => {
    const d = digits(v).padStart(11, ''); if (d.length !== 11) return v || '';
    return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  };

  const fmtCNPJ = v => {
    const d = digits(v).padStart(14, ''); if (d.length !== 14) return v || '';
    return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  };

  // ÚNICA função de data: aceita 'aaaa-mm-dd' e 'aaaa-mm-ddTHH:MM:SS...' e mantém dd/mm/aaaa
  const fmtDataBR = v => {
    const s = String(v || '').trim();
    const mISO = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (mISO) return `${mISO[3]}/${mISO[2]}/${mISO[1]}`;
    return s; // se já estiver em dd/mm/aaaa, mantém
  };

  const setTextAll = (k, v) => {
    document.querySelectorAll(`[data-k="${k}"]`).forEach(el => el.textContent = v || '');
  };

  const notInformed = '<em>Não informado.</em>';

  // Mapas para compromissos 5.x
  const COMP_VALUE_TO_CODE = {
    'Manter regularidade nos repasses e nas parcelas (arts. 14 e 15 da Portaria MTP 1.467/2022)': '5.1',
    'Regularidade no encaminhamento de documentos (art. 241 da Portaria MTP 1.467/2022)': '5.2',
    'Utilizar recursos previdenciários apenas para finalidades legais': '5.3',
    'Aplicar recursos conforme CMN': '5.4',
    'Promover adequações na legislação do RPPS': '5.5',
    'Cumprir Planos de Ação nas fases Específica e de Manutenção': '5.6',
    'Promover o equilíbrio financeiro e atuarial do RPPS e a sustentabilidade do seu plano de custeio e de benefícios': '5.7'
  };

  // 7.x a partir de texto livre
  function extractCond7Codes(raw) {
    const t = String(raw || '');
    const seen = new Set();
    if (/\b7\.?1\b|art\.\s*3\b|requisitos.*anexo\s*xviii/i.test(t)) seen.add('7.1');
    if (/\b7\.?2\b|planos?\s*de\s*ação|art\.\s*4\b/i.test(t))        seen.add('7.2');
    if (/\b7\.?3\b|art\.\s*6\b|prazos|condiç|parcelament/i.test(t))  seen.add('7.3');
    if (/\b7\.?4\b|n[aã]o\s+ingresso\s+com\s+a[cç][aã]o|judicial/i.test(t)) seen.add('7.4');
    ['7.1','7.2','7.3','7.4'].forEach(code => { if (new RegExp(code.replace('.','\\.')).test(t)) seen.add(code); });
    return ['7.1','7.2','7.3','7.4'].filter(c => seen.has(c));
  }

  function extractCompCodesFromPayload(p){
    const seen = new Set();
    const agg = String(p.COMPROMISSO_FIRMADO_ADESAO || '');
    ['5.1','5.2','5.3','5.4','5.5','5.6','5.7'].forEach(code => {
      const re = new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`);
      if (re.test(agg)) seen.add(code);
    });
    agg.split(';').map(s=>s.trim()).forEach(label=>{
      const code = COMP_VALUE_TO_CODE[label];
      if (code) seen.add(code);
    });
    return ['5.1','5.2','5.3','5.4','5.5','5.6','5.7'].filter(c => seen.has(c));
  }

  // ========= Render principal =========
  function renderizarTermo(payload){
    // 1) Campos diretos
    setTextAll('uf',          payload.UF || '');
    setTextAll('ente',        payload.ENTE || '');
    setTextAll('cnpj_ente',   fmtCNPJ(payload.CNPJ_ENTE || ''));
    setTextAll('email_ente',  payload.EMAIL_ENTE || '');
    setTextAll('ug',          payload.UG || '');
    setTextAll('cnpj_ug',     fmtCNPJ(payload.CNPJ_UG || ''));
    setTextAll('email_ug',    payload.EMAIL_UG || '');

    setTextAll('nome_rep_ente',  payload.NOME_REP_ENTE || '');
    setTextAll('cargo_rep_ente', payload.CARGO_REP_ENTE || '');
    setTextAll('cpf_rep_ente',   fmtCPF(payload.CPF_REP_ENTE || ''));
    setTextAll('email_rep_ente', payload.EMAIL_REP_ENTE || '');

    setTextAll('nome_rep_ug',  payload.NOME_REP_UG || '');
    setTextAll('cargo_rep_ug', payload.CARGO_REP_UG || '');
    setTextAll('cpf_rep_ug',   fmtCPF(payload.CPF_REP_UG || ''));
    setTextAll('email_rep_ug', payload.EMAIL_REP_UG || '');

    setTextAll('venc_ult_crp', fmtDataBR(payload.DATA_VENCIMENTO_ULTIMO_CRP || ''));
    setTextAll('data_termo',   fmtDataBR(payload.DATA_TERMO_GERADO || ''));


    // 1.1 – Esfera de Governo (1.1.1 / 1.1.2)
    (function(){
      const listId = 'opt-1-1';
      const list = document.getElementById(listId);
      if (!list) return;
      const esfera = String(payload.ESFERA || payload.ESFERA_DE_GOVERNO || '').toLowerCase();
      const codes = [];
      if (/municip/.test(esfera)) codes.push('1.1.1');
      if (/estadual|distrit/.test(esfera)) codes.push('1.1.2');

      const items = [...list.querySelectorAll('li')];
      if (!codes.length){
        items.forEach(li => li.remove());
        const li = document.createElement('li'); li.innerHTML = notInformed; list.appendChild(li);
      } else {
        items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
      }

      // legenda da assinatura (ente municipal x estadual/distrital)
      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        sig.innerHTML = (/estadual|distrit/.test(esfera))
          ? 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>'
          : 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
      }
    })();

    // 3.2 – Tipo de emissão do último CRP (3.2.1 / 3.2.2)
    (function(){
      const listId = 'opt-3-2';
      const list = document.getElementById(listId);
      if (!list) return;
      const raw = String(payload.TIPO_EMISSAO_ULTIMO_CRP || '');
      const codes = [];
      if (/admin/i.test(raw) || /3\.2\.1/.test(raw)) codes.push('3.2.1');
      if (/judic/i.test(raw)  || /3\.2\.2/.test(raw)) codes.push('3.2.2');

      const items = [...list.querySelectorAll('li')];
      if (!codes.length){
        items.forEach(li => li.remove());
        const li = document.createElement('li'); li.innerHTML = notInformed; list.appendChild(li);
      } else {
        items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
      }
    })();

    // 3.3 – Critérios irregulares
    (function(){
      const ul = document.getElementById('criterios-list'); if (!ul) return;
      ul.innerHTML = '';
      const arr = Array.isArray(payload.CRITERIOS_IRREGULARES) ? payload.CRITERIOS_IRREGULARES
                : Array.isArray(payload.CRIERIOS_IRREGULARES) ? payload.CRIERIOS_IRREGULARES : [];
      if (!arr.length){
        const li = document.createElement('li'); li.innerHTML = notInformed; ul.appendChild(li);
      } else {
        arr.forEach(txt => { const li = document.createElement('li'); li.textContent = String(txt || ''); ul.appendChild(li); });
      }
    })();

    // 4) A/B – Finalidades iniciais
    (function(){
      const a = String(payload.CELEBRACAO_TERMO_PARCELA_DEBITOS || '').trim();
      const b = String(payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '').trim();
      const labels = [];
      if (a) labels.push('A - Parcelamento de débitos.');
      if (b) labels.push('B - Regularização de pendências para emissão administrativa e regular do CRP. Detalhamento da(s) finalidade(s)');
      const el = document.getElementById('finalidades-iniciais');
      if (el) el.innerHTML = labels.length ? labels.join(' e/ou ') : notInformed;
    })();
    // util para filtrar listas por códigos
    function filterBy(listId, codes){
      const list = document.getElementById(listId);
      if (!list) return;
      const items = [...list.querySelectorAll('li')];
      if (!codes.length){
        items.forEach(li => li.remove());
        const li = document.createElement('li'); li.innerHTML = notInformed; list.appendChild(li);
        return;
      }
      items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
    }

    // 4.1 / 4.2 / 4.3 / 4.4
    (function(){
      const raw = String(payload.CELEBRACAO_TERMO_PARCELA_DEBITOS || '');
      const codes = [];
      if (/4\.1\.1|sessent|60\b/i.test(raw)) codes.push('4.1.1');
      if (/4\.1\.2|trezent|300\b/i.test(raw)) codes.push('4.1.2');
      filterBy('opt-4-1', codes);
    })();
    (function(){
      const raw = String(payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '');
      const codes = [];
      if (/4\.2\.1|sem\s+decis/i.test(raw)) codes.push('4.2.1');
      if (/4\.2\.2|com\s+decis/i.test(raw)) codes.push('4.2.2');
      filterBy('opt-4-2', codes);
    })();
    (function(){
      const raw = String(payload.DEFICIT_ATUARIAL || '');
      const codes = [];
      if (/4\.3\.1|implementa/i.test(raw)) codes.push('4.3.1');
      if (/4\.3\.2|prazo/i.test(raw))      codes.push('4.3.2');
      if (/4\.3\.3|altern/i.test(raw))     codes.push('4.3.3');
      filterBy('opt-4-3', codes);
    })();
    (function(){
      const raw = String(payload.CRITERIOS_ESTRUT_ESTABELECIDOS || '');
      const codes = [];
      if (/4\.4\.1|unidade\s+gestora|\§\s*20/i.test(raw)) codes.push('4.4.1');
      if (/4\.4\.2|outro\s+crit/i.test(raw))               codes.push('4.4.2');
      filterBy('opt-4-4', codes);
    })();

    // 5.x (compromissos)
    (function(){
      const codes = extractCompCodesFromPayload(payload);
      filterBy('opt-5', codes);
    })();

    // 6.x
    (function(){
      const raw = String(payload.PROVIDENCIA_NECESS_ADESAO || '');
      const codes = [];
      if (/6\.?1\b|inclus[aã]o|incluir|cadprev/i.test(raw)) codes.push('6.1');
      if (/6\.?2\b|inexist[eê]ncia|j[aá]\s*regulariz/i.test(raw)) codes.push('6.2');
      filterBy('opt-6', codes);
    })();

    // 7 – Condições (apenas marcadas)
    (function(){
      const raw = String(payload.CONDICAO_VIGENCIA || '');
      const codes = extractCond7Codes(raw);
      filterBy('opt-7', codes);
    })();

    // Re-hidrata spans de assinatura que dependem de 'ente/uf'
    setTextAll('ente', payload.ENTE || '');
    setTextAll('uf',   payload.UF   || '');

    // 🔔 Sinaliza ao backend (Puppeteer) que terminou de renderizar
    try {
      if (!window.__TERMO_READY_FIRED__) {
        window.__TERMO_READY_FIRED__ = true;
        const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        fontsReady.finally(() => {
          requestAnimationFrame(() => {
            document.dispatchEvent(new CustomEvent('TERMO_PRINT_READY'));
          });
        });
      }
    } catch (_) {}
  }

  // ========= Fluxo 1: Preview (postMessage) =========
  window.addEventListener('message', (ev) => {
    try {
      // Aceita mesma origin OU, se for about:blank (popup inicial), aceita mesmo assim.
      const sameOrigin = ev.origin === window.location.origin;
      const isAboutBlank = !ev.origin || ev.origin === 'null';
      if (!sameOrigin && !isAboutBlank) return;
    } catch (_) {}

    if (!ev.data || ev.data.type !== 'TERMO_PREVIEW_DATA') return;
    try {
      renderizarTermo(ev.data.payload || {});
    } catch (e) {
      console.error('[TERMO_PREVIEW_DATA] render error:', e);
    }
  }, false);


  // ========= Fluxo 2: PDF (Puppeteer) =========
  document.addEventListener('TERMO_DATA_READY', () => {
    renderizarTermo(window.__TERMO_DATA__ || {});
  });

  // ========= Fallback: querystring antiga =========
  document.addEventListener('DOMContentLoaded', () => {
    if (window.__TERMO_DATA__) { renderizarTermo(window.__TERMO_DATA__ || {}); return; }
    const p = new URLSearchParams(location.search);
    if (p.has('uf') || p.has('ente')) {
      const payload = {
        UF: p.get('uf') || '', ENTE: p.get('ente') || '',
        CNPJ_ENTE: p.get('cnpj_ente') || '', EMAIL_ENTE: p.get('email_ente') || '',
        UG: p.get('ug') || '', CNPJ_UG: p.get('cnpj_ug') || '', EMAIL_UG: p.get('email_ug') || '',
        ESFERA: p.get('esfera') || '',
        NOME_REP_ENTE: p.get('nome_rep_ente') || '', CPF_REP_ENTE: p.get('cpf_rep_ente') || '',
        CARGO_REP_ENTE: p.get('cargo_rep_ente') || '', EMAIL_REP_ENTE: p.get('email_rep_ente') || '',
        NOME_REP_UG: p.get('nome_rep_ug') || '', CPF_REP_UG: p.get('cpf_rep_ug') || '',
        CARGO_REP_UG: p.get('cargo_rep_ug') || '', EMAIL_REP_UG: p.get('email_rep_ug') || '',
        DATA_VENCIMENTO_ULTIMO_CRP: p.get('venc_ult_crp') || '',
        TIPO_EMISSAO_ULTIMO_CRP: p.get('tipo_emissao_crp') || '',
        CELEBRACAO_TERMO_PARCELA_DEBITOS: p.get('celebracao') || '',
        REGULARIZACAO_PENDEN_ADMINISTRATIVA: p.get('regularizacao') || '',
        DEFICIT_ATUARIAL: p.get('deficit') || '',
        CRITERIOS_ESTRUT_ESTABELECIDOS: p.get('criterios_estrut') || '',
        MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: p.get('manutencao_normas') || '',
        COMPROMISSO_FIRMADO_ADESAO: p.get('compromisso') || p.get('compromissos') || '',
        PROVIDENCIA_NECESS_ADESAO: p.get('providencias') || '',
        CONDICAO_VIGENCIA: p.get('condicao_vigencia') || '',
        DATA_TERMO_GERADO: p.get('data_termo') || '',
        CRITERIOS_IRREGULARES: Array.from(p.entries())
          .filter(([k,v]) => /^criterio\d+$/i.test(k) && v)
          .map(([,v]) => v)
      };
      renderizarTermo(payload);
    }
  });
})();
