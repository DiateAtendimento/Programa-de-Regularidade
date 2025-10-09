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

    // Data do termo (Etapa 7/registro)
    setTextAll('data_termo',   fmtDataBR(p.DATA_TERMO_GERADO || ''));

    // 1.1 – Esfera de Governo (deduzido só para legenda/checkbox)
    (function(){
      const list = document.getElementById('opt-1-1');
      if (!list) return;

      // Heurística simples pela presença de "Prefeitura/Município" → Municipal
      const ente = String(p.ENTE || '').toLowerCase();
      const esfera = /estado|distrito/.test(ente) ? 'estadual' : 'municipal';
      const codes = [];
      if (esfera === 'municipal') codes.push('1.1.1');
      if (esfera === 'estadual')  codes.push('1.1.2');

      const items = [...list.querySelectorAll('li')];
      if (!codes.length){
        items.forEach(li => li.remove());
        const li = document.createElement('li'); li.innerHTML = notInformed; list.appendChild(li);
      } else {
        items.forEach(li => { if (!codes.includes(li.getAttribute('data-code'))) li.remove(); });
      }

      // legenda da assinatura
      const sig = document.getElementById('sig-cap-ente');
      if (sig) {
        sig.innerHTML = (esfera === 'estadual')
          ? 'Representante legal do Estado/Distrito de <span data-k="ente"></span>/<span data-k="uf"></span>'
          : 'Representante legal do Município de <span data-k="ente"></span>/<span data-k="uf"></span>';
      }
    })();

    // ===== Etapa 3 =====
    // 3.1 – Critério(s) irregular(es) no extrato previdenciário
    (function(){
      const list = document.getElementById('criterios-list');
      if (!list) return;

      const raw = p.CRITERIOS_IRREGULARES;
      const arr = Array.isArray(raw)
        ? raw
        : String(raw || '')
            .split(/[;,]/)         // aceita ; ou ,
            .map(s => s.trim())
            .filter(Boolean);      // remove vazios

      list.innerHTML = arr.length
        ? arr.map(v => `<li>${v}</li>`).join('')
        : '<li><em>Não informado.</em></li>';
    })();

  // 3.2 – Adesão sem irregularidades (quando aplicável)
  (function(){
    const box = document.getElementById('blk-3-2-adesao');
    const ul  = document.getElementById('finalidades-3-2');
    if (!box || !ul) return;

    const flag = String(p.ADESAO_SEM_IRREGULARIDADES || '').trim().toUpperCase();
    const isYes = (flag === 'SIM' || flag === 'TRUE' || flag === '1' || flag === 'ON' || flag === 'X');

    if (!isYes) {
      // Mostra explicitamente o fallback
      ul.innerHTML = '<li><em>Não informado.</em></li>';
      // (opcional) garantir que o bloco apareça mesmo assim:
      // box.style.removeProperty('display');
      return;
    }

    // Se SIM, garante visibilidade
    box.style.removeProperty('display');

    const reasons = [];
    // 1 item “fixo” exigido
    reasons.push('Adesão realizada sem irregularidades no extrato previdenciário');

    // (Opcional) listar finalidades iniciais do payload, quando vierem não-vazias
    const mapFinalidades = [
      ['CELEBRACAO_TERMO_PARCELA_DEBITOS', 'Celebração de termos de parcelamento/reparcelamento.'],
      ['REGULARIZACAO_PENDEN_ADMINISTRATIVA', 'Regularização de pendências administrativas.'],
      ['DEFICIT_ATUARIAL', 'Equacionamento de déficit atuarial/prazos.'],
      ['CRITERIOS_ESTRUT_ESTABELECIDOS', 'Organização por critérios estruturantes.'],
      ['MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS', 'Manutenção da conformidade às normas gerais.']
    ];
    for (const [k, txt] of mapFinalidades) {
      if (String(p[k] || '').trim()) reasons.push(txt);
    }

    ul.innerHTML = reasons.map(r => `<li>${r}</li>`).join('');
  })();




    // ===== Etapa 4 – FINALIDADES =====
    // Criamos uma string-aggregator só com os campos previstos nas etapas
    const finsTxt = [
      p.CELEBRACAO_TERMO_PARCELA_DEBITOS,
      p.REGULARIZACAO_PENDEN_ADMINISTRATIVA,
      p.DEFICIT_ATUARIAL,
      p.CRITERIOS_ESTRUT_ESTABELECIDOS,
      p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS
    ].map(s => String(s || '')).join(' | ').toLowerCase();

    // 4.1 – até 300 parcelas
    (function(){
      const codes = /trezent|300\b|parcelament|reparcelament/.test(finsTxt) ? ['4.1.1'] : [];
      filterBy('opt-4-1', codes);
    })();

    // 4.2 – regularização administrativa (3 itens)
    (function(){
      const src = String(p.REGULARIZACAO_PENDEN_ADMINISTRATIVA || '').toLowerCase();
      const codes = [];
      if (/4\.2\.1|sem decis/i.test(src)) codes.push('4.2.1');
      if (/4\.2\.2|com decis/i.test(src)) codes.push('4.2.2');
      if (/4\.2\.3|lit[ií]gio/.test(src)) codes.push('4.2.3');
      filterBy('opt-4-2', codes);
    })();

    // 4.3 – déficit atuarial
    (function(){
      const src = String(p.DEFICIT_ATUARIAL || '').toLowerCase();
      const codes = [];
      if (/4\.3\.1|implementa/i.test(src)) codes.push('4.3.1');
      if (/4\.3\.2|prazo|adequ[aá]..o/.test(src)) codes.push('4.3.2');
      if (/4\.3\.3|alternativo/.test(src)) codes.push('4.3.3');
      filterBy('opt-4-3', codes);
    })();

    // 4.4 – critérios estruturantes
    (function(){
      const src = String(p.CRITERIOS_ESTRUT_ESTABELECIDOS || '').toLowerCase();
      const codes = [];
      if (/4\.4\.1|unidade\s+gestora|\§\s*20|§\s*20/.test(src)) codes.push('4.4.1');
      if (/4\.4\.2|outro/.test(src))                             codes.push('4.4.2');
      filterBy('opt-4-4', codes);
    })();

    // 4.5 – adequações (texto único; ativa se o campo citar adequações/EC 103 ou código 4.5)
    (function(){
      const src = [
        p.CRITERIOS_ESTRUT_ESTABELECIDOS,
        p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS
      ].map(s=>String(s||'').toLowerCase()).join(' | ');
      const codes = (/4\.5|ec\s*103|adequ[aá]..o da legisla|adequacoes da legislacao/.test(src)) ? ['4.5'] : [];
      filterBy('opt-4-5', codes);
    })();

    // 4.6 – Manutenção da Conformidade
    (function(){
      const src = String(p.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS || '').toLowerCase();
      const codes = [];
      if (/n[ií]vel\s*ii\b|pequeno\s+porte/.test(src)) codes.push('4.6.1');
      if (/n[ií]vel\s*iii\b|m[eé]dio|grande\s+porte/.test(src)) codes.push('4.6.2');
      if (/n[ií]vel\s*iv\b|porte\s+especial/.test(src)) codes.push('4.6.3');
      filterBy('opt-4-6', codes);
    })();

    // Sinalizar que terminou de renderizar (usado pelo Puppeteer)
    window.__TERMO_PRINT_READY__ = true;
    document.dispatchEvent(new CustomEvent('TERMO_PRINT_READY'));


    // ===== Etapa 5 – Compromissos (5.1 a 5.8) =====
    (function(){
      const src = String(p.COMPROMISSO_FIRMADO_ADESAO || '');
      const codes = [];
      ['5.1','5.2','5.3','5.4','5.5','5.6','5.7','5.8'].forEach(code=>{
        const re = new RegExp(`(^|\\D)${code.replace('.','\\.')}(\\D|$)`);
        if (re.test(src)) codes.push(code);
      });
      filterBy('opt-5', codes);
    })();

    // ===== Etapa 6 – Providências (6.1/6.2) =====
    (function(){
      const src = String(p.PROVIDENCIA_NECESS_ADESAO || '');
      const codes = [];
      if (/6\.?1\b|inclus[aã]o|cadprev/i.test(src)) codes.push('6.1');
      if (/6\.?2\b|inexist[eê]ncia|j[aá]\s*regulariz/i.test(src)) codes.push('6.2');
      filterBy('opt-6', codes);
    })();

    // ===== Etapa 7 – Condições (7.1–7.4) =====
    (function(){
      const src = String(p.CONDICAO_VIGENCIA || '');
      const codes = [];
      if (/7\.?1\b|condi[cç][oõ]es.*compromissos|atendimento/i.test(src)) codes.push('7.1');
      if (/7\.?2\b|planos?\s*de\s*a[cç][aã]o/i.test(src))                codes.push('7.2');
      if (/7\.?3\b|art\.\s*7\b|anexo\s*xvii|parcelament/i.test(src))     codes.push('7.3');
      if (/7\.?4\b|n[aã]o\s+ingresso\s+com\s+a[cç][aã]o|judicial/i.test(src)) codes.push('7.4');
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

        // Etapa 4
        CELEBRACAO_TERMO_PARCELA_DEBITOS: q.get('celebracao') || '',
        REGULARIZACAO_PENDEN_ADMINISTRATIVA: q.get('regularizacao') || '',
        DEFICIT_ATUARIAL: q.get('deficit') || '',
        CRITERIOS_ESTRUT_ESTABELECIDOS: q.get('criterios_estrut') || '',
        MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: q.get('manutencao_normas') || '',

        // Etapa 5–7
        COMPROMISSO_FIRMADO_ADESAO: q.get('compromissos') || q.get('compromisso') || '',
        PROVIDENCIA_NECESS_ADESAO: q.get('providencias') || '',
        CONDICAO_VIGENCIA: q.get('condicao_vigencia') || '',

        // Registro
        DATA_TERMO_GERADO: q.get('data_termo') || ''
      };
      renderizarTermo(payload);
    }
  });
})();
