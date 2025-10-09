// termo.js (ALINHADO AO FORM ETAPAS 1–7)
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
    return s;
  };

  const setTextAll = (k, v) => {
    const text = (v == null || String(v).trim() === '') ? '' : v;
    document.querySelectorAll(`[data-k="${k}"]`).forEach(el => el.textContent = text);
  };

  const notInformed = '<em>Não informado.</em>';

  // ===== util para filtrar listas por códigos =====
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

  // ========= Render principal =========
  function renderizarTermo(p){
    // 1) Campos diretos – Etapa 1
    setTextAll('uf',          p.UF || '');
    setTextAll('ente',        p.ENTE || '');
    setTextAll('cnpj_ente',   fmtCNPJ(p.CNPJ_ENTE || ''));
    setTextAll('email_ente',  p.EMAIL_ENTE || '');
    setTextAll('ug',          p.UG || '');
    setTextAll('cnpj_ug',     fmtCNPJ(p.CNPJ_UG || ''));
    setTextAll('email_ug',    p.EMAIL_UG || '');

    // Etapa 2 – responsáveis (inclui telefones)
    setTextAll('nome_rep_ente',  p.NOME_REP_ENTE || '');
    setTextAll('cargo_rep_ente', p.CARGO_REP_ENTE || '');
    setTextAll('cpf_rep_ente',   fmtCPF(p.CPF_REP_ENTE || ''));
    setTextAll('email_rep_ente', p.EMAIL_REP_ENTE || '');
    setTextAll('tel_rep_ente',   p.TEL_REP_ENTE || '');

    setTextAll('nome_rep_ug',  p.NOME_REP_UG || '');
    setTextAll('cargo_rep_ug', p.CARGO_REP_UG || '');
    setTextAll('cpf_rep_ug',   fmtCPF(p.CPF_REP_UG || ''));
    setTextAll('email_rep_ug', p.EMAIL_REP_UG || '');
    setTextAll('tel_rep_ug',   p.TEL_REP_UG || '');

    setTextAll('data_termo',   fmtDataBR(p.DATA_TERMO_GERADO || ''));

    // 1.1 – Esfera de Governo
    (function(){
      const list = document.getElementById('opt-1-1');
      if (!list) return;
      const esfRaw = p.ESFERA_GOVERNO ?? p.ESFERA ?? p.ESFERA_DE_GOVERNO;
      const esfera = Array.isArray(esfRaw) ? esfRaw.join(' ').toLowerCase() : String(esfRaw || '').toLowerCase();
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

      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        sig.innerHTML = (/estadual|distrit/.test(esfera))
          ? 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>'
          : 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
      }
    })();

    // ===== Etapa 3 =====
    // 3.1 – Critérios irregulares
    (function(){
      const list = document.getElementById('criterios-list');
      if (!list) return;
      const arr = Array.isArray(p.CRITERIOS_IRREGULARES)
        ? p.CRITERIOS_IRREGULARES
        : String(p.CRITERIOS_IRREGULARES || '')
            .split(';').map(s=>s.trim()).filter(Boolean);

      list.innerHTML = arr.length ? arr.map(v => `<li>${v}</li>`).join('') : `<li>${notInformed}</li>`;
    })();

    // 3.2 – Adesão sem irregularidades (bullets das finalidades)
    (function(){
      const box = document.getElementById('blk-3-2-adesao');
      if (!box) return;
      const flag = String(p.ADESAO_SEM_IRREGULARIDADES || '').trim().toUpperCase();
      const isYes = (flag === 'SIM' || flag === 'TRUE' || flag === '1' || flag === 'ON' || flag === 'X');
      if (!isYes){ box.remove(); return; }

      const reasons = [];
      if (String(p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS || '').trim()) reasons.push('Manutenção da conformidade.');
      if (String(p.DEFICIT_ATUARIAL || '').trim())                      reasons.push('Equacionamento de déficit atuarial e prazos de implementação/adequação.');
      if (String(p.CRITERIOS_ESTRUT_ESTABELECIDOS || '').trim())        reasons.push('Organização do RPPS conforme critérios estruturantes (incl. art. 40, §20, CF).');
      if (String(p.OUTRO_CRITERIO_COMPLEXO || '').trim())               reasons.push('Outro critério de maior complexidade para o RPPS/ente.');

      const ul = document.getElementById('finalidades-3-2');
      if (ul) ul.innerHTML = reasons.length ? reasons.map(r => `<li>${r}</li>`).join('') : `<li>${notInformed}</li>`;
    })();

    // ===== Etapa 4 – FINALIDADES =====
    // Espera-se p.FINALIDADES como array (ou string ';')
    const fins = (()=>{
      if (Array.isArray(p.FINALIDADES)) return p.FINALIDADES;
      const s = String(p.FINALIDADES || '').trim();
      return s ? s.split(';').map(x=>x.trim()).filter(Boolean) : [];
    })().join(' | ').toLowerCase();

    // 4.1 – até 300 parcelas
    (function(){
      const codes = /trezent|300\b|parcelament|reparcelament/.test(fins) ? ['4.1.1'] : [];
      filterBy('opt-4-1', codes);
    })();

    // 4.2 – regularização administrativa (3 itens)
    (function(){
      const codes = [];
      if (/4\.2\.1|sem decis/i.test(fins)) codes.push('4.2.1');
      if (/4\.2\.2|com decis/i.test(fins)) codes.push('4.2.2');
      if (/4\.2\.3|lit[ií]gio/.test(fins)) codes.push('4.2.3');
      filterBy('opt-4-2', codes);
    })();

    // 4.3 – déficit atuarial
    (function(){
      const codes = [];
      if (/4\.3\.1|implementa..o de plano|equacionamento do d[ée]ficit/.test(fins)) codes.push('4.3.1');
      if (/4\.3\.2|prazos adicionais|adequ[aá]..o or[çc]ament[áa]ria/.test(fins))   codes.push('4.3.2');
      if (/4\.3\.3|plano alternativo|55.*§\s*7/.test(fins))                         codes.push('4.3.3');
      filterBy('opt-4-3', codes);
    })();

    // 4.4 – critérios estruturantes
    (function(){
      const codes = [];
      if (/4\.4\.1|unidade gestora [uú]nica|§\s*20/.test(fins)) codes.push('4.4.1');
      if (/4\.4\.2|outro crit[ée]rio/.test(fins))                codes.push('4.4.2');
      filterBy('opt-4-4', codes);
    })();

    // 4.5 – adequações da legislação (item único)
    (function(){
      const codes = /4\.5|adequ[aá]..es da legisla..o|ec\s*103/.test(fins) ? ['4.5'] : [];
      filterBy('opt-4-5', codes);
    })();

    // 4.6 – manutenção da conformidade (5 itens)
    (function(){
      const codes = [];
      if (/n[ií]vel\s*ii\b|pequeno porte/.test(fins))                           codes.push('4.6.1');
      if (/n[ií]vel\s*iii\b|m[eé]dio|grande porte/.test(fins))                  codes.push('4.6.2');
      if (/n[ií]vel\s*iv\b|porte especial/.test(fins))                          codes.push('4.6.3');
      if (/evolu[cç][aã]o favor[aá]vel|situa[cç][aã]o financeira e atuarial/.test(fins)) codes.push('4.6.4');
      if (/acompanhamento atuarial|arts?\.\s*67\s*a\s*69/.test(fins))           codes.push('4.6.5');
      filterBy('opt-4-6', codes);
    })();

    // ===== Etapa 5 – Compromissos (5.1 a 5.8) =====
    (function(){
      const src = Array.isArray(p.COMPROMISSOS) ? p.COMPROMISSOS.join(' | ')
                : String(p.COMPROMISSOS || p.COMPROMISSO_FIRMADO_ADESAO || '');
      const codes = [];
      ['5.1','5.2','5.3','5.4','5.5','5.6','5.7','5.8'].forEach(code=>{
        const re = new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`);
        if (re.test(src)) codes.push(code);
      });
      filterBy('opt-5', codes);
    })();

    // ===== Etapa 6 – Providências (6.1/6.2) =====
    (function(){
      const src = Array.isArray(p.PROVIDENCIAS) ? p.PROVIDENCIAS.join(' | ') : String(p.PROVIDENCIAS || '');
      const codes = [];
      if (/6\.?1\b|inclus[aã]o|cadprev/i.test(src)) codes.push('6.1');
      if (/6\.?2\b|inexist[eê]ncia|j[aá]\s*regulariz/i.test(src)) codes.push('6.2');
      filterBy('opt-6', codes);
    })();

    // ===== Etapa 7 – Condições (7.1–7.4) =====
    (function(){
      const src = Array.isArray(p.CONDICOES) ? p.CONDICOES.join(' | ') : String(p.CONDICOES || p.CONDICAO_VIGENCIA || '');
      const codes = [];
      if (/7\.?1\b|condi[cç][oõ]es.*compromissos/i.test(src)) codes.push('7.1');
      if (/7\.?2\b|planos?\s*de\s*a[cç][aã]o/i.test(src))     codes.push('7.2');
      if (/7\.?3\b|art\.\s*7\b|anexo\s*xvii|parcelament/i.test(src)) codes.push('7.3');
      if (/7\.?4\b|n[aã]o\s+ingresso\s+com\s+a[cç][aã]o|judicial/i.test(src))   codes.push('7.4');
      filterBy('opt-7', codes);
    })();

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
        ESFERA_GOVERNO: q.getAll('esfera') || q.get('esfera') || '',

        NOME_REP_ENTE: q.get('nome_rep_ente') || '', CPF_REP_ENTE: q.get('cpf_rep_ente') || '',
        CARGO_REP_ENTE: q.get('cargo_rep_ente') || '', EMAIL_REP_ENTE: q.get('email_rep_ente') || '',
        TEL_REP_ENTE: q.get('tel_rep_ente') || '',

        NOME_REP_UG: q.get('nome_rep_ug') || '', CPF_REP_UG: q.get('cpf_rep_ug') || '',
        CARGO_REP_UG: q.get('cargo_rep_ug') || '', EMAIL_REP_UG: q.get('email_rep_ug') || '',
        TEL_REP_UG: q.get('tel_rep_ug') || '',

        // Etapa 3
        CRITERIOS_IRREGULARES: (()=>{
          const multi = q.getAll('criterio'); if (multi && multi.length) return multi;
          const joined = q.get('criterios') || ''; return joined ? joined.split(';').map(s=>s.trim()).filter(Boolean) : [];
        })(),
        ADESAO_SEM_IRREGULARIDADES: q.get('adesao_sem_irregularidades') || '',
        MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: q.get('manutencao_normas') || '',
        DEFICIT_ATUARIAL: q.get('deficit') || '',
        CRITERIOS_ESTRUT_ESTABELECIDOS: q.get('criterios_estrut') || '',
        OUTRO_CRITERIO_COMPLEXO: q.get('outro_criterio_complexo') || '',

        // Etapa 4 – FINALIDADES (aceita ?fin=... múltiplos ou ?finalidades=...;...;...)
        FINALIDADES: (()=>{
          const multi = q.getAll('fin');
          if (multi && multi.length) return multi;
          const joined = q.get('finalidades') || '';
          return joined ? joined.split(';').map(s=>s.trim()).filter(Boolean) : [];
        })(),

        // Etapa 5–7
        COMPROMISSOS: q.getAll('comp') || q.get('compromissos') || '',
        PROVIDENCIAS: q.getAll('prov') || q.get('providencias') || '',
        CONDICOES: q.getAll('cond') || q.get('condicoes') || '',

        DATA_TERMO_GERADO: q.get('data_termo') || ''
      };
      renderizarTermo(payload);
    }
  });
})();
