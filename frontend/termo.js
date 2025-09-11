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
  const setTextAll = (k, v) => {
    document.querySelectorAll(`[data-k="${k}"]`).forEach(el => el.textContent = v || '');
  };
  const notInformed = '<em>Não informado.</em>';

  // Mapeamento (mesmo do frontend) para detectar códigos 5.x a partir dos textos
  const COMP_VALUE_TO_CODE = {
    'Manter regularidade nos repasses e nas parcelas (arts. 14 e 15 da Portaria MTP 1.467/2022)': '5.1',
    'Regularidade no encaminhamento de documentos (art. 241 da Portaria MTP 1.467/2022)': '5.2',
    'Utilizar recursos previdenciários apenas para finalidades legais': '5.3',
    'Aplicar recursos conforme CMN': '5.4',
    'Promover adequações na legislação do RPPS': '5.5',
    'Cumprir Planos de Ação nas fases Específica e de Manutenção': '5.6',
    'Promover o equilíbrio financeiro e atuarial do RPPS e a sustentabilidade do seu plano de custeio e de benefícios': '5.7'
  };

  function extractCompCodesFromPayload(p){
    const seen = new Set();
    const agg = String(p.COMPROMISSO_FIRMADO_ADESAO || '');
    // 1) Se o texto já tiver "5.x"
    ['5.1','5.2','5.3','5.4','5.5','5.6','5.7'].forEach(code => {
      const re = new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`);
      if (re.test(agg)) seen.add(code);
    });
    // 2) Tenta mapear pelos rótulos selecionados
    agg.split(';').map(s=>s.trim()).forEach(label=>{
      const code = COMP_VALUE_TO_CODE[label];
      if (code) seen.add(code);
    });
    return ['5.1','5.2','5.3','5.4','5.5','5.6','5.7'].filter(c => seen.has(c));
  }

  // ========= Render principal (usa somente 'payload') =========
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

    setTextAll('venc_ult_crp',     payload.DATA_VENCIMENTO_ULTIMO_CRP || '');
    setTextAll('tipo_emissao_crp', payload.TIPO_EMISSAO_ULTIMO_CRP || '');
    setTextAll('manutencao_normas', payload.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS || '');
    setTextAll('data_termo',        payload.DATA_TERMO_GERADO || '');

    // 2) Esfera 1.1
    (function renderEsfera(){
      const esfera = String(payload.ESFERA || '').toLowerCase();
      const li = document.getElementById('li-esfera');
      if (li) {
        if (esfera.includes('municip')) li.textContent = '1.1.1 RPPS Municipal';
        else if (esfera.includes('estadual') || esfera.includes('distrital')) li.textContent = '1.1.2 Estadual/Distrital';
        else li.innerHTML = notInformed;
      }

      // legenda da assinatura
      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        if (esfera.includes('estadual') || esfera.includes('distrital')) {
          sig.innerHTML = 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>';
        } else {
          sig.innerHTML = 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
        }
      }
    })();
    // 3) 3.3 Critérios irregulares (padronizado para CRITERIOS_IRREGULARES, com fallback)
    (function renderCriterios(){
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

    // 4) Finalidades (texto A/B)
    (function renderFinalidades(){
      const a = String(payload.CELEBRACAO_TERMO_PARCELA_DEBITOS || '').trim();
      const b = String(payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '').trim();
      const labels = [];
      if (a) labels.push('A - Parcelamento de débitos.');
      if (b) labels.push('B - Regularização de pendências para emissão administrativa e regular do CRP. Detalhamento da(s) finalidade(s)');
      const el = document.getElementById('finalidades-iniciais');
      if (el) el.innerHTML = labels.length ? labels.join(' e/ou ') : 'Não informado.';
    })();

    // 5) Seleções 4.x / 6.x / 5.x
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

    // 4.1
    (function(){
      const raw = String(payload.CELEBRACAO_TERMO_PARCELA_DEBITOS || '');
      const codes = [];
      if (/4\.1\.1|sessent|60\b/i.test(raw)) codes.push('4.1.1');
      if (/4\.1\.2|trezent|300\b/i.test(raw)) codes.push('4.1.2');
      filterBy('opt-4-1', codes);
    })();

    // 4.2
    (function(){
      const raw = String(payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '');
      const codes = [];
      if (/4\.2\.1|sem\s+decis/i.test(raw)) codes.push('4.2.1');
      if (/4\.2\.2|com\s+decis/i.test(raw)) codes.push('4.2.2');
      filterBy('opt-4-2', codes);
    })();

    // 4.3
    (function(){
      const raw = String(payload.DEFICIT_ATUARIAL || '');
      const codes = [];
      if (/4\.3\.1|implementa/i.test(raw)) codes.push('4.3.1');
      if (/4\.3\.2|prazo/i.test(raw))      codes.push('4.3.2');
      if (/4\.3\.3|altern/i.test(raw))     codes.push('4.3.3');
      filterBy('opt-4-3', codes);
    })();

    // 4.4
    (function(){
      const raw = String(payload.CRITERIOS_ESTRUT_ESTABELECIDOS || '');
      const codes = [];
      if (/4\.4\.1|unidade\s+gestora|\§\s*20/i.test(raw)) codes.push('4.4.1');
      if (/4\.4\.2|outro\s+crit/i.test(raw))               codes.push('4.4.2');
      filterBy('opt-4-4', codes);
    })();

    // 6.x
    (function(){
      const raw = String(payload.PROVIDENCIA_NECESS_ADESAO || '');
      const codes = [];
      if (/6\.?1\b|inclus[aã]o|incluir|cadprev/i.test(raw)) codes.push('6.1');
      if (/6\.?2\b|inexist[eê]ncia|j[aá]\s*regulariz/i.test(raw)) codes.push('6.2');
      filterBy('opt-6', codes);
    })();

    // 5.x (compromissos)
    (function(){
      const codes = extractCompCodesFromPayload(payload);
      const list = document.getElementById('opt-5');
      if (!list) return;
      const items = [...list.querySelectorAll('li')];
      if (!codes.length){
        items.forEach(li => li.remove());
        const li = document.createElement('li'); li.innerHTML = notInformed; list.appendChild(li);
        return;
      }
      items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
    })();

    // 7 – Condições marcadas (texto livre)
    (function(){
      const ul = document.getElementById('condicoes-list');
      if (!ul) return;
      ul.innerHTML = '';
      const raw = String(payload.CONDICAO_VIGENCIA || '');
      const parts = raw.split(';').map(s => s.trim()).filter(Boolean);
      if (!parts.length){
        const li = document.createElement('li'); li.innerHTML = notInformed; ul.appendChild(li);
      } else {
        parts.forEach(txt => { const li = document.createElement('li'); li.textContent = txt; ul.appendChild(li); });
      }
    })();

    // Re-hidrata spans dentro das assinaturas que dependem de 'ente/uf'
    setTextAll('ente', payload.ENTE || '');
    setTextAll('uf',   payload.UF   || '');

    // 🔔 Sinaliza ao backend (Puppeteer) que terminou de renderizar
    try {
      // evita disparos duplicados se a função for chamada mais de uma vez
      if (!window.__TERMO_READY_FIRED__) {
        window.__TERMO_READY_FIRED__ = true;

        // aguarda fontes (se suportado) e aplica na próxima frame
        const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        fontsReady.finally(() => {
          requestAnimationFrame(() => {
            document.dispatchEvent(new CustomEvent('TERMO_PRINT_READY'));
          });
        });
      }
    } catch (_) {}

  }
  // ========= Fluxo 1: Preview (janela aberta pelo frontend)
  window.addEventListener('message', (ev) => {
    try {
      if (ev.origin !== window.location.origin) return;
    } catch (_) { /* ignore */ }
    if (!ev.data || ev.data.type !== 'TERMO_PREVIEW_DATA') return;
    const payload = ev.data.payload || {};
    renderizarTermo(payload);
  }, false);

  // ========= Fluxo 2: PDF (Puppeteer) — backend injeta e dispara evento
  document.addEventListener('TERMO_DATA_READY', () => {
    renderizarTermo(window.__TERMO_DATA__ || {});
  });

  // ========= Fallback opcional: querystring antiga OU __TERMO_DATA__ já presente
  document.addEventListener('DOMContentLoaded', () => {
    if (window.__TERMO_DATA__) {
      renderizarTermo(window.__TERMO_DATA__ || {});
      return;
    }
    // compat com versões antigas (se alguém abrir termo.html?uf=...&ente=...)
    const p = new URLSearchParams(location.search);
    if (p.has('uf') || p.has('ente')) {
      const payload = {
        UF: p.get('uf') || '',
        ENTE: p.get('ente') || '',
        CNPJ_ENTE: p.get('cnpj_ente') || '',
        EMAIL_ENTE: p.get('email_ente') || '',
        UG: p.get('ug') || '',
        CNPJ_UG: p.get('cnpj_ug') || '',
        EMAIL_UG: p.get('email_ug') || '',
        ESFERA: p.get('esfera') || '',
        NOME_REP_ENTE: p.get('nome_rep_ente') || '',
        CPF_REP_ENTE: p.get('cpf_rep_ente') || '',
        CARGO_REP_ENTE: p.get('cargo_rep_ente') || '',
        EMAIL_REP_ENTE: p.get('email_rep_ente') || '',
        NOME_REP_UG: p.get('nome_rep_ug') || '',
        CPF_REP_UG: p.get('cpf_rep_ug') || '',
        CARGO_REP_UG: p.get('cargo_rep_ug') || '',
        EMAIL_REP_UG: p.get('email_rep_ug') || '',
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
