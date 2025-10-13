//solic_crp.js

// solic_crp.js — fluxo completo da Solicitação de CRP Emergencial (isolado da Adesão)

(() => {

  // === DEBUG global (ligue/desligue quando quiser) ===
  window.__DEBUG_SOLIC_CRP__ = true;
  function dbg(...args){ if (window.__DEBUG_SOLIC_CRP__) console.log(...args); }
  function dbe(...args){ if (window.__DEBUG_SOLIC_CRP__) console.error(...args); }

  /* ========= Config ========= */
  const API_BASE = (function(){
    const override = (window.__API_BASE && String(window.__API_BASE).replace(/\/+$/, '')) || '';
    if (override) return override;
    // fallback padrão (Netlify + dev) via proxy
    return '/_api';
  })();

  
  const api = (p) => `${API_BASE}${p.startsWith('/') ? p : '/' + p}`;
  // (opcional) chave para o backend
  const API_KEY = window.__API_KEY || '';
  const withKey = (h = {}) => (API_KEY ? { ...h, 'X-API-Key': API_KEY } : h)

  const FORM_STORAGE_KEY = 'solic-crp-form-v1';
  const IDEM_STORE_KEY   = 'rpps-idem-submit:solic-crp';
  const FORM_TTL_MS      = 30 * 60 * 1000;              // 30 min

  /* ========= Utils ========= */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const digits  = v => String(v||'').replace(/\D+/g,'');
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fmtBR   = d => d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const fmtHR   = d => d.toLocaleTimeString('pt-BR',{hour12:false,timeZone:'America/Sao_Paulo'});

  const hex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
  function newIdemKey(){
    try{ const a=new Uint8Array(16); crypto.getRandomValues(a); return 'id_'+hex(a); }
    catch{ return 'id_'+Math.random().toString(36).slice(2)+Date.now().toString(36); }
  }
  function rememberIdemKey(key){ try{ localStorage.setItem(IDEM_STORE_KEY, JSON.stringify({ key, ts: Date.now() })); }catch{} }
  function takeIdemKey(){
    try{ const raw=localStorage.getItem(IDEM_STORE_KEY); if(!raw) return null; const {key}=JSON.parse(raw)||{}; return key||null; }catch{ return null; }
  }
  function clearIdemKey(){ try{ localStorage.removeItem(IDEM_STORE_KEY); }catch{} }

  // --- Normalização de data vinda da planilha/API (número serial/ISO/string) -> dd/mm/aaaa
  function toDateBR(v){
    if (v == null || v === '') return '';
    // Número serial (Google Sheets/Excel) — pode vir como number OU string "45927"
    if ((typeof v === 'number' && isFinite(v)) || (/^\d{4,6}$/.test(String(v).trim()))) {
      const n = Number(v);
      const base = new Date(1899, 11, 30); // Sheets base
      const d = new Date(base.getTime() + n * 86400000);
      return fmtBR(d);
    }
    // ISO (yyyy-mm-dd...)
    const iso = String(v).trim();
    const mIso = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (mIso) return `${mIso[3]}/${mIso[2]}/${mIso[1]}`;
    // Já em PT-BR ou outro texto: mantém
    return iso;
  }

  // --- Validação do nº Gescon: S|L + 6 dígitos + "/" + ano
  function isGesconNumber(x){
    return /^[SL]\d{6}\/\d{4}$/i.test(String(x).trim());
  }
  /* ========= Robust fetch (timeout + retries) ========= */
  const FETCH_TIMEOUT_MS = 120000;
  const FETCH_RETRIES    = 1;

  async function fetchJSON(
    url,
    { method='GET', headers={}, body=null } = {},
    { label='request', timeout=FETCH_TIMEOUT_MS, retries=FETCH_RETRIES } = {}
  ){
    let attempt=0;
    const bust = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sep  = url.includes('?') ? '&' : '?';
    const finalURL = `${url}${sep}${bust}`;

    while(true){
      attempt++;
      const ctrl = new AbortController();
      const to   = setTimeout(()=>ctrl.abort(`timeout:${label}`), timeout);

      if (window.__DEBUG_SOLIC_CRP__) {
        const safeHeaders = { ...headers };
        if (safeHeaders['X-API-Key']) safeHeaders['X-API-Key'] = '***';
        dbg(`[fetchJSON] → ${label}`, { finalURL, method, headers: safeHeaders, body });
      }

      try{
        const start = performance.now();
        const res = await fetch(finalURL, {
          method, headers, body, signal: ctrl.signal,
          cache:'no-store', credentials:'same-origin', redirect:'follow', mode:'cors'
        });
        const dur = Math.round(performance.now() - start);
        clearTimeout(to);

        const ct = res.headers.get('content-type') || '';
        const isJson = ct.includes('application/json');
        const txt = await res.text(); // lemos uma vez
        const data = isJson ? (JSON.parse(txt || 'null')) : txt;

        if (window.__DEBUG_SOLIC_CRP__) {
          dbg(`[fetchJSON] ← ${label} (${dur}ms)`, {
            status: res.status,
            ok: res.ok,
            headers: {
              'content-type': ct,
              'x-cache': res.headers.get('x-cache') || undefined
            },
            preview: isJson ? data : (String(txt).slice(0,300) + (txt.length>300?'…':'')),
          });
        }

        if(!res.ok){
          const err = new Error((isJson && (data?.error || data?.message)) || `HTTP ${res.status}`);
          err.status = res.status;
          err.response = data;
          throw err;
        }

        return isJson ? data : txt;

      }catch(e){
        clearTimeout(to);
        const m = String(e?.message||'').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');
        const retriable =
          (isHttp && (e.status===429 || e.status===502 || e.status===503 || e.status===504 || e.status>=500)) ||
          m.includes('timeout:') || m.includes('etimedout') || m.includes('abort') ||
          m.includes('econnreset') || m.includes('socket hang up') || m.includes('eai_again') ||
          m.includes('failed to fetch') || (!navigator.onLine);

        dbe(`[fetchJSON][erro] ${label}`, { attempt, message: e?.message, status: e?.status, response: e?.response });

        if(retriable && attempt <= (retries+1)){
          const backoff = Math.min(4000, 300 * Math.pow(2, attempt-1));
          await new Promise(r=>setTimeout(r, backoff)); continue;
        }
        throw e;
      }
    }
  }


  async function fetchBinary(
    url,
    { method='GET', headers={}, body=null } = {},
    { label='binary', timeout=FETCH_TIMEOUT_MS, retries=FETCH_RETRIES } = {}
  ){
    let attempt=0;
    const bust = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sep  = url.includes('?') ? '&' : '?';
    const finalURL = `${url}${sep}${bust}`;

    while(true){
      attempt++;
      const ctrl = new AbortController();
      const to   = setTimeout(()=>ctrl.abort(`timeout:${label}`), timeout);
      try{
        const res = await fetch(finalURL, {
          method, headers, body, signal: ctrl.signal,
          cache:'no-store', credentials:'same-origin', redirect:'follow', mode:'cors'
        });
        clearTimeout(to);
        if(!res.ok){ const err=new Error(`HTTP ${res.status}`); err.status=res.status; throw err; }
        return await res.blob();
      }catch(e){
        clearTimeout(to);
        const m = String(e?.message||'').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');
        const retriable =
          (isHttp && (e.status===429 || e.status===503 || e.status===504 || e.status>=500)) ||
          m.includes('timeout:') || !navigator.onLine || m.includes('failed');
        if(retriable && attempt <= (retries+1)){
          const backoff = 300 * Math.pow(2, attempt-1);
          await new Promise(r=>setTimeout(r, backoff)); continue;
        }
        throw e;
      }
    }
  }

  function friendlyErrorMessages(err, fallback='Falha ao comunicar com o servidor.'){
    const status = err?.status;
    const msg = String(err?.message||'').toLowerCase();
    if(!navigator.onLine) return ['Sem conexão com a internet. Verifique sua rede e tente novamente.'];
    if(status===504 || msg.includes('timeout:')) return ['Tempo de resposta esgotado. Tente novamente.'];
    if(status===502) return ['Servidor reiniciando. Tente de novo em instantes.'];
    if(status===429) return ['Muitas solicitações. Aguarde alguns segundos e tente novamente.'];
    if(status===404) return ['Registro não encontrado. Verifique os dados.'];
    if(status && status>=500) return ['Instabilidade no servidor. Tente novamente.'];
    return [fallback];
  }

  /* ========= Elementos ========= */
  const el = {
    // etapa 0
    cnpjInput: $('#CNPJ_ENTE_PESQ'),
    btnPesquisar: $('#btnPesquisar'),
    slotNextStep0: $('#slotNextStep0'),
    btnNext: $('#btnNext'),
    btnPrev: $('#btnPrev'),
    btnSubmit: $('#btnSubmit'),
    btnGerar: $('#btnGerarFormulario'),
    hasGescon: $('#HAS_TERMO_ENC_GESCON'),

    // info Gescon
    boxGescon: $('#gesconInfoBox'),
    spanNGescon: $('#N_GESCON'),
    spanDataEnc: $('#DATA_ENC_VIA_GESCON'),
    spanUfGescon: $('#UF_GESCON'),
    spanEnteGescon: $('#ENTE_GESCON'),
    infoDataEncGescon: $('#infoDataEncGescon'),

    // etapa 1
    uf: $('#UF'), ente: $('#ENTE'), cnpjEnte: $('#CNPJ_ENTE'), emailEnte: $('#EMAIL_ENTE'),
    ug: $('#UG'), cnpjUg: $('#CNPJ_UG'), emailUg: $('#EMAIL_UG'),
    esfMun: $('#esf_mun'), esfEst: $('#esf_est'),
    infoNumGescon: $('#infoNumGescon'),

    // etapa 2
    cpfRepEnte: $('#CPF_REP_ENTE'), nomeRepEnte: $('#NOME_REP_ENTE'),
    cargoRepEnte: $('#CARGO_REP_ENTE'), emailRepEnte: $('#EMAIL_REP_ENTE'), telRepEnte: $('#TEL_REP_ENTE'),
    cpfRepUg: $('#CPF_REP_UG'), nomeRepUg: $('#NOME_REP_UG'),
    cargoRepUg: $('#CARGO_REP_UG'), emailRepUg: $('#EMAIL_REP_UG'), telRepUg: $('#TEL_REP_UG'),

    // etapa 3
    grpCrit: $('#grpCRITERIOS'),

    // etapa 4
    faseChecks: $$('.fase-check'),
    blk41: $('#blk_41'), blk42: $('#blk_42'), blk43: $('#blk_43'),
    blk44: $('#blk_44'), blk45: $('#blk_45'), blk46: $('#blk_46'),
    f42Lista: $('#F42_LISTA'), f43Lista: $('#F43_LISTA'),
    f44Crits: $('#F44_CRITERIOS'), f44Final: $('#F44_FINALIDADES'),
    f46Crits: $('#F46_CRITERIOS'), f46Final: $('#F46_FINALIDADES'),

    // etapa 5
    justGerais: $('#JUSTIFICATIVAS_GERAIS'),

    // carimbos
    mes: $('#MES'), dataSol: $('#DATA_SOLIC_GERADA'),
    horaSol: $('#HORA_SOLIC_GERADA'), anoSol: $('#ANO_SOLIC_GERADA'),

    // seções p/ stepper fallback
    sections: $$('.app-section'),
    dots: $$('#stepper .step'),
    navFooter: $('#navFooter')
  };

  /* ========= Máscaras ========= */
  function maskCNPJ(v){
    const d = digits(v).slice(0,14);
    let o = d;
    if(d.length>2) o = d.slice(0,2)+'.'+d.slice(2);
    if(d.length>5) o = o.slice(0,6)+'.'+o.slice(6);
    if(d.length>8) o = o.slice(0,10)+'/'+o.slice(10);
    if(d.length>12) o = o.slice(0,15)+'-'+o.slice(15);
    return o;
  }
  function maskCPF(v){
    const d = digits(v).slice(0,11);
    let o = d;
    if(d.length>3)  o = d.slice(0,3)+'.'+d.slice(3);
    if(d.length>6)  o = o.slice(0,7)+'.'+o.slice(7);
    if(d.length>9)  o = o.slice(0,11)+'-'+o.slice(11);
    return o;
  }
  function maskPhone(v){
    const d = digits(v).slice(0,11);
    if(d.length<=10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/,'($1) $2-$3').trim();
    return d.replace(/(\d{2})(\d{5})(\d{0,4})/,'($1) $2-$3').trim();
  }
  function bindMasks(){
    el.cnpjInput?.addEventListener('input', ()=> el.cnpjInput.value = maskCNPJ(el.cnpjInput.value));
    el.cnpjEnte?.addEventListener('input', ()=> el.cnpjEnte.value = maskCNPJ(el.cnpjEnte.value));
    el.cnpjUg  ?.addEventListener('input', ()=> el.cnpjUg.value   = maskCNPJ(el.cnpjUg.value));
    el.cpfRepEnte?.addEventListener('input', ()=> el.cpfRepEnte.value = maskCPF(el.cpfRepEnte.value));
    el.cpfRepUg  ?.addEventListener('input', ()=> el.cpfRepUg.value   = maskCPF(el.cpfRepUg.value));
    el.telRepEnte?.addEventListener('input', ()=> el.telRepEnte.value = maskPhone(el.telRepEnte.value));
    el.telRepUg  ?.addEventListener('input', ()=> el.telRepUg.value   = maskPhone(el.telRepUg.value));
    // Enter na pesquisa
    $('#CNPJ_ENTE_PESQ')?.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); el.btnPesquisar?.click(); }
    });
  }
  /* ========= Persistência (TTL) ========= */
  function getState(){
    try{ return JSON.parse(localStorage.getItem(FORM_STORAGE_KEY) || 'null'); }catch{ return null; }
  }
  function setState(updater){
    const prev = getState() || { step: 0, values:{}, lastSaved: 0, finalizedAt: 0 };
    const next = (typeof updater==='function') ? updater(prev) : { ...prev, ...updater };
    next.lastSaved = Date.now();
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(next));
    return next;
  }
  function clearAllState(){
    try{ localStorage.removeItem(FORM_STORAGE_KEY); }catch{}
    clearIdemKey();
  }
  function saveState(){
    const prev = getState();
    const data = {
      step: curStep,
      values: {},
      lastSaved: Date.now(),
      finalizedAt: prev?.finalizedAt || 0
    };
    [
      'UF','ENTE','CNPJ_ENTE','EMAIL_ENTE','UG','CNPJ_UG','EMAIL_UG',
      'CPF_REP_ENTE','NOME_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE',
      'CPF_REP_UG','NOME_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG',
      'JUSTIFICATIVAS_GERAIS'
    ].forEach(id=>{ const e=$('#'+id); if(e) data.values[id]=e.value; });

    data.values['esf_mun'] = !!el.esfMun?.checked;
    data.values['esf_est'] = !!el.esfEst?.checked;
    data.values['FASES_MARCADAS[]'] = $$('.fase-check:checked').map(i => i.value);

    // 3.2
    data.values['ADESAO_SEM_IRREGULARIDADES'] =
      $('#chkSemIrregularidades')?.checked ? 'SIM' : '';

    data.values['FIN_3_2_MANUTENCAO_CONFORMIDADE'] =
      document.querySelector('input[name="MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS"]')?.checked ? 'SIM' : '';

    data.values['FIN_3_2_DEFICIT_ATUARIAL'] =
      document.querySelector('input[name="DEFICIT_ATUARIAL"]')?.checked ? 'SIM' : '';

    data.values['FIN_3_2_CRITERIOS_ESTRUTURANTES'] =
      document.querySelector('input[name="CRITERIOS_ESTRUT_ESTABELECIDOS"]')?.checked ? 'SIM' : '';

    data.values['FIN_3_2_OUTRO_CRITERIO_COMPLEXO'] =
      document.querySelector('input[name="OUTRO_CRITERIO_COMPLEXO"]')?.checked ? 'SIM' : '';

    // 3.3 critérios
    data.values['CRITERIOS_IRREGULARES[]'] = $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i=>i.value);

    // fase selecionada
    const faseSel = $('input[name="FASE_PROGRAMA"]:checked'); data.values['FASE_PROGRAMA'] = faseSel?.value||'';

    // 4.1
    const f41 = $('input[name="F41_OPCAO"]:checked'); data.values['F41_OPCAO'] = f41?.value||'';

    // 4.2
    data.values['F42_LISTA[]'] = $$(`#F42_LISTA input[type="checkbox"]:checked`).map(i=>i.value);

    // 4.3
    data.values['F43_LISTA[]'] = $$(`#F43_LISTA input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F43_JUST']    = $('#F43_JUST')?.value || '';
    data.values['F43_PLANO']   = $('#F43_PLANO')?.value || '';
    data.values['F43_INCLUIR[]'] = $$('#F43_INCLUIR input[type="checkbox"]:checked').map(i=>i.value);

    // 4.4
    data.values['F44_CRITERIOS[]']   = $$(`#F44_CRITERIOS input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_DECLS[]']       = $$(`#blk_44 .d-flex input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_FINALIDADES[]'] = $$(`#F44_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_ANEXOS']        = $('#F44_ANEXOS')?.value || '';
    data.values['F441_OPTD']        = !!$('#F441_OPTD')?.checked;
    data.values['F441_LEGISLACAO']  = $('#F441_LEGISLACAO')?.value || '';
    data.values['F445_DESC_PLANOS'] = $('#F445_DESC_PLANOS')?.value || '';
    data.values['F446_DOCS']        = $('#F446_DOCS')?.value || '';
    data.values['F446_EXEC_RES']    = $('#F446_EXEC_RES')?.value || '';

    // 4.5
    data.values['F45_OK451'] = !!$('#blk_45 input[type="checkbox"]:checked');
    data.values['F45_DOCS']  = $('#F45_DOCS')?.value || '';
    data.values['F45_JUST']  = $('#F45_JUST')?.value || '';

    // 4.5.3
    data.values['F453_EXEC_RES'] = $('#F453_EXEC_RES')?.value || '';

    // 4.6
    data.values['F46_CRITERIOS[]']   = $$(`#F46_CRITERIOS input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F46_PROGESTAO']     = $('#F46_PROGESTAO')?.value || '';
    data.values['F46_PORTE']         = $('#F46_PORTE')?.value || '';
    data.values['F46_JUST_D']        = $('#F46_JUST_D')?.value || '';
    data.values['F46_DOCS_D']        = $('#F46_DOCS_D')?.value || '';
    data.values['F46_JUST_E']        = $('#F46_JUST_E')?.value || '';
    data.values['F46_DOCS_E']        = $('#F46_DOCS_E')?.value || '';
    data.values['F46_FINALIDADES[]'] = $$(`#F46_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F46_ANEXOS']        = $('#F46_ANEXOS')?.value || '';
    data.values['F46_JUST_PLANOS']   = $('#F46_JUST_PLANOS')?.value || '';
    data.values['F46_COMP_CUMPR']    = $('#F46_COMP_CUMPR')?.value || '';
    data.values['F462F_OPTF']       = !!$('#F462F_OPTF')?.checked;
    data.values['F462F_CRITERIOS[]']= $$('#F462F_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value);
    data.values['F466_DOCS']        = $('#F466_DOCS')?.value || '';
    data.values['F466_EXEC_RES']    = $('#F466_EXEC_RES')?.value || '';

    // 4.3.10
    data.values['F4310_OPCAO']      = document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '';
    data.values['F4310_LEGISLACAO'] = $('#F4310_LEGISLACAO')?.value || '';
    data.values['F4310_DOCS']       = $('#F4310_DOCS')?.value || '';

    // 4.3.12
    data.values['F43_SOLICITA_INCLUSAO'] = !!$('#F43_SOLICITA_INCLUSAO')?.checked;
    data.values['F43_DESC_PLANOS']       = $('#F43_DESC_PLANOS')?.value || '';

    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(data));
  }

  function loadState(){
    try{
      const raw = localStorage.getItem(FORM_STORAGE_KEY);
      if(!raw) return null;
      const st  = JSON.parse(raw);
      const now = Date.now();
      if(st.lastSaved && (now - st.lastSaved > FORM_TTL_MS)){ clearAllState(); return null; }

      const vals = st.values || {};
      // Restaura campos que são arrays (terminam com [])
      Object.entries(vals).forEach(([k,v])=>{
        if (k.endsWith('[]')){
          $$(`input[name="${k}"]`).forEach(i => { i.checked = Array.isArray(v) && v.includes(i.value); });
        }
      });
      // Restaura campos simples por id
      Object.entries(vals).forEach(([k,v])=>{
        if (k.endsWith('[]')) return;
        const e = $('#'+k); if(!e) return;
        if (e.type==='checkbox' || e.type==='radio'){ e.checked = !!v; } else { e.value = v ?? ''; }
      });

      // 3.2 — restaurar marcações
      if (vals['ADESAO_SEM_IRREGULARIDADES'] === 'SIM') {
        const c = document.getElementById('chkSemIrregularidades');
        if (c) c.checked = true;
      }

      // 4.3.10 radios/áreas condicionais
      (function(){
        const v = st.values?.['F4310_OPCAO'] || '';
        const r = v && document.querySelector(`input[name="F4310_OPCAO"][value="${v}"]`);
        if (r) { r.checked = true; }
        const a = document.getElementById('F4310_LEGISLACAO_WRAP');
        const b = document.getElementById('F4310_DOCS_WRAP');
        if (a) a.classList.toggle('d-none', v !== 'A');
        if (b) b.classList.toggle('d-none', v !== 'B');
      })();

      // 4.3.12 toggle
      (function(){
        const chk = document.getElementById('F43_SOLICITA_INCLUSAO');
        const wrap = document.getElementById('F43_INCLUSAO_WRAP');
        if (chk && wrap) {
          chk.checked = !!st.values?.['F43_SOLICITA_INCLUSAO'];
          wrap.classList.toggle('d-none', !chk.checked);
        }
      })();

      // 4.4.1 (d)
      (function(){
        const ck = document.getElementById('F441_OPTD');
        const w  = document.getElementById('F441_LEGISLACAO_WRAP');
        if (ck && w) w.classList.toggle('d-none', !ck.checked);
      })();

      // 4.4.2 (e)
      (function(){
        const ck = document.getElementById('F442_OPTE');
        const w  = document.getElementById('F44_CRIT_WRAP');
        if (ck && w) w.classList.toggle('d-none', !ck.checked);
      })();

      // 4.6.2 (f)
      (function(){
        const ck = document.getElementById('F462F_OPTF');
        const w  = document.getElementById('F462F_WRAP');
        if (ck && w) w.classList.toggle('d-none', !ck.checked);
      })();

      (function(){
        const map = [
          ['FIN_3_2_MANUTENCAO_CONFORMIDADE', 'MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS'],
          ['FIN_3_2_DEFICIT_ATUARIAL',        'DEFICIT_ATUARIAL'],
          ['FIN_3_2_CRITERIOS_ESTRUTURANTES', 'CRITERIOS_ESTRUT_ESTABELECIDOS'],
          ['FIN_3_2_OUTRO_CRITERIO_COMPLEXO', 'OUTRO_CRITERIO_COMPLEXO'],
        ];
        map.forEach(([k,name])=>{
          if (vals[k] === 'SIM') {
            const c = document.querySelector(`input[name="${name}"]`);
            if (c) c.checked = true;
          }
        });
      })();

      return st;
    }catch{ return null; }
  }


  /* ========= Stepper fallback ========= */
  let curStep = 0;

  function ensureStepperFallback(){
    if(!el.sections.length || !el.btnNext || !el.btnPrev) return;

    // se já inicializado, só re-renderiza e sai
    if (ensureStepperFallback._inited) { window.__renderStepper?.(); return; }
    ensureStepperFallback._inited = true;

    function render(){
      el.sections.forEach((sec,i)=> sec.style.display = (i===curStep ? '' : 'none'));
      el.dots.forEach((d,i)=> d.classList.toggle('active', i===curStep));
      el.btnPrev.style.visibility = (curStep===0 ? 'hidden' : 'visible');
      el.btnNext.classList.toggle('d-none', curStep === el.sections.length-1);
      el.btnSubmit.classList.toggle('d-none', !(curStep === el.sections.length-1));
      if (el.btnNext) el.btnNext.disabled = (curStep === 0 && el.hasGescon?.value !== '1');

      const slot = el.slotNextStep0;
      if(slot){
        if(curStep===0 && el.btnNext.parentElement!==slot) slot.appendChild(el.btnNext);
        if(curStep!==0 && el.btnNext.parentElement===slot) el.navFooter?.insertBefore(el.btnNext, el.btnSubmit);
      }
      saveState();
    }
    window.__renderStepper = render;

    function next(){
      if(curStep === 0 && el.hasGescon?.value!=='1'){ showModal('modalBusca'); return; }
      if(curStep === 4){
        const vf = validarFaseSelecionada();
        if(!vf.ok){ showAtencao([vf.motivo]); return; }
      }
      if(curStep < el.sections.length-1){ curStep++; render(); }
    }
    function prev(){ if(curStep>0){ curStep--; render(); } }

    el.btnNext.addEventListener('click', next);
    el.btnPrev.addEventListener('click', prev);

    const st = loadState();
    curStep = Number.isFinite(st?.step) ? Math.max(0, Math.min(el.sections.length-1, Number(st.step))) : 0;
    render();
  }
  /* ========= Modais (Atenção/Erro) ========= */
  function showAtencao(msgs){
    const list = $('#modalAtencaoLista'); if(list){ list.innerHTML = msgs.map(m=>`<li>${m}</li>`).join(''); }
    showModal('modalAtencao');
  }
  // (mantemos APENAS a versão de showErro declarada mais abaixo)

  /* ========= Lottie nos modais desta página ========= */
  const lotties = {};
  function mountLottie(id, path, {loop=true, autoplay=true}={}){
    const c = document.getElementById(id); if(!c) return;
    if(lotties[id]){ lotties[id].destroy(); delete lotties[id]; }
    try{ lotties[id] = lottie.loadAnimation({ container:c, path, loop, autoplay, renderer:'svg' }); }catch{}
  }
  $('#modalSucesso')?.addEventListener('shown.bs.modal', ()=> mountLottie('lottieSuccess','animacao/confirm-success.json',{loop:false,autoplay:true}));
  $('#modalGerandoPdf')?.addEventListener('shown.bs.modal', ()=> mountLottie('lottieGerandoPdf','animacao/gerando-pdf.json',{loop:true,autoplay:true}));
  $('#modalSalvando')?.addEventListener('shown.bs.modal', ()=> mountLottie('lottieSalvando','animacao/gerando-pdf.json',{loop:true,autoplay:true}));
  /* ========= Gate: Gescon TERMO_ENC_GESCON & Termos_registrados ========= */
  let searching = false;

  async function consultarGesconByCnpj(cnpj){
    const body = { cnpj };
    dbg('[consultarGesconByCnpj] >> body:', body);
    const out = await fetchJSON(api('/gescon/termo-enc'), {
      method:'POST',
      headers: withKey({'Content-Type':'application/json'}),
      body: JSON.stringify(body)
    }, { label:'gescon/termo-enc', retries: 0 });
    dbg('[consultarGesconByCnpj] <<', out);
    return out;
  }

  async function consultarTermosRegistrados(cnpj){
    const body = { cnpj };
    dbg('[consultarTermosRegistrados] >> body:', body);
    const out = await fetchJSON(api('/termos-registrados'), {
      method:'POST',
      headers: withKey({'Content-Type':'application/json'}),
      body: JSON.stringify(body)
    }, { label:'termos-registrados', retries: 0 });
    dbg('[consultarTermosRegistrados] <<', out);
    return out;
  }


  async function onPesquisar(ev){
    if (searching) return;

    const raw = el.cnpjInput?.value || '';
    const cnpj = digits(raw);
    console.group('[solic_crp] Pesquisa CNPJ');
    dbg('Entrada (raw):', raw);
    dbg('Normalizado (digits):', cnpj);

    if (cnpj.length !== 14) {
      console.warn('CNPJ inválido (esperado 14 dígitos).');
      console.groupEnd();
      showAtencao(['Informe um CNPJ válido (14 dígitos).']);
      return;
    }

    searching = true;
    const btn = el.btnPesquisar;
    const old = btn?.innerHTML;
    btn && (btn.disabled = true, btn.innerHTML = 'Pesquisando…');

    try {
      console.time('[solic_crp] gescon/termo-enc');
      const data = await consultarGesconByCnpj(cnpj);
      console.timeEnd('[solic_crp] gescon/termo-enc');
      dbg('Resposta gescon/termo-enc:', data);

      let ok = !!(data && data.n_gescon && data.uf && data.ente && data.data_enc_via_gescon);
      if (ok && !isGesconNumber(data.n_gescon)) {
        console.warn('Número Gescon com formato inválido:', data.n_gescon);
        ok = false;
      }

      if (!ok) {
        dbg('Sem registro válido Gescon → desbloqueando fluxo e tentando hidratar termos…');
        el.hasGescon && (el.hasGescon.value = '0');
        if (el.btnNext) el.btnNext.disabled = false;
        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';
        const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = '—';
        try { await hidratarTermosRegistrados(cnpj); } catch (e) { dbe('hidratarTermosRegistrados falhou (sem bloqueio):', e); }
        if (curStep === 0) { curStep = 1; window.__renderStepper?.(); }
        console.groupEnd();
        return;
      }

      // ✅ registro encontrado
      const dataEncBR = toDateBR(data.data_enc_via_gescon);
      el.hasGescon && (el.hasGescon.value = '1');
      if (el.btnNext) el.btnNext.disabled = false;

      el.spanNGescon && (el.spanNGescon.textContent = data.n_gescon || '');
      el.spanDataEnc && (el.spanDataEnc.textContent = dataEncBR || '');
      // Preencher o bloco introdutório (Etapa 1)
      const introNG = document.getElementById('intro_N_GESCON');
      const introDT = document.getElementById('intro_DATA_ENC');
      if (introNG) introNG.textContent = data.n_gescon || '—';
      if (introDT) introDT.textContent = toDateBR(data.data_enc_via_gescon) || '—';

      el.spanUfGescon && (el.spanUfGescon.textContent = data.uf || '');
      el.spanEnteGescon && (el.spanEnteGescon.textContent = data.ente || '');
      el.boxGescon?.classList.remove('d-none');

      el.infoDataEncGescon && (el.infoDataEncGescon.textContent = dataEncBR || '—');
      const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = data.n_gescon || '—';

      dbg('Chamando hidratarTermosRegistrados…');
      await hidratarTermosRegistrados(cnpj);
      dbg('hidratarTermosRegistrados → OK');

      if (curStep === 0) { curStep = 1; window.__renderStepper?.(); }
      console.groupEnd();

    } catch (err) {
      dbe('Erro na pesquisa do CNPJ:', { status: err?.status, message: err?.message, response: err?.response });
      if (err && err.status === 404) {
        dbg('CNPJ não localizado no Gescon → desbloqueando fluxo e tentando hidratar…');
        el.hasGescon && (el.hasGescon.value = '0');
        if (el.btnNext) el.btnNext.disabled = false;
        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';
        const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = '—';
        try { await hidratarTermosRegistrados(cnpj); } catch (e) {}
        if (curStep === 0) { curStep = 1; window.__renderStepper?.(); }
      } else {
        showErro(friendlyErrorMessages(err, 'Falha ao consultar informações.'));
      }
    } finally {
      btn && (btn.disabled = false, btn.innerHTML = old || 'Pesquisar');
      searching = false;
    }
  }

  async function hidratarTermosRegistrados(cnpj){
    dbg('[hidratarTermosRegistrados] start →', cnpj);
    try{
      const data = await consultarTermosRegistrados(cnpj);
      if (!data || typeof data !== 'object') throw new Error('payload vazio/inesperado');

      const ente = data?.ente || {};
      const resp = data?.responsaveis || {};
      const crp  = data?.crp || {};

      // 1) Ente + UG
      if (ente.uf)   { el.uf.value = ente.uf; }
      if (ente.nome) { el.ente.value = ente.nome; }
      if (el.cnpjEnte) el.cnpjEnte.value = maskCNPJ(ente.cnpj || cnpj);
      if (ente.email) el.emailEnte.value = ente.email;
      if (ente.ug)      el.ug.value      = ente.ug;
      if (ente.cnpj_ug) el.cnpjUg.value  = maskCNPJ(ente.cnpj_ug);
      if (ente.email_ug)el.emailUg.value = ente.email_ug;

      // 2) Responsáveis
      if (resp.ente){
        el.cpfRepEnte.value   = resp.ente.cpf || '';
        el.nomeRepEnte.value  = resp.ente.nome || '';
        el.cargoRepEnte.value = resp.ente.cargo || '';
        el.emailRepEnte.value = resp.ente.email || '';
        el.telRepEnte.value   = resp.ente.telefone || '';
      }
      if (resp.ug){
        el.cpfRepUg.value   = resp.ug.cpf || '';
        el.nomeRepUg.value  = resp.ug.nome || '';
        el.cargoRepUg.value = resp.ug.cargo || '';
        el.emailRepUg.value = resp.ug.email || '';
        el.telRepUg.value   = resp.ug.telefone || '';
      }

      // 3) CRP anterior — estes campos NÃO existem no form_2; proteger
      if (crp.data_venc && el.dataUltCrp) el.dataUltCrp.value = crp.data_venc;
      if (crp.tipo) {
        if (crp.tipo === 'Administrativa' && el.tipoAdm) el.tipoAdm.checked = true;
        if (crp.tipo === 'Judicial'       && el.tipoJud) el.tipoJud.checked = true;
      }

      // === 3.1 Critérios irregulares ===
      let irregs = Array.isArray(crp.irregulares) ? crp.irregulares.slice() : [];
      if (!irregs.length) {
        const s = data?.CRITERIOS_IRREGULARES || crp?.CRITERIOS_IRREGULARES || '';
        if (s) {
          irregs = String(s).split(/;|,/).map(t => t.trim()).filter(Boolean);
        }
      }
      if (irregs.length && el.grpCrit) {
        const opts = $$('input[name="CRITERIOS_IRREGULARES[]"]', el.grpCrit);
        const norm = x => String(x||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
        const num  = x => (String(x).match(/^\s*(\d+)[\.\-]/)?.[1] || '');
        const wanted = irregs.map(v=>({raw:v, n:num(v), k:norm(v)}));

        opts.forEach(inp=>{
          const val = inp.value;
          const lbl = inp.nextElementSibling ? inp.nextElementSibling.textContent : '';
          const cand = [val, lbl].filter(Boolean);
          const has = wanted.some(w =>
            (w.n && (num(val)===w.n || num(lbl)===w.n)) ||
            cand.some(c => norm(c).includes(w.k))
          );
          if (has) inp.checked = true;
        });
      }

      // === 3.2 Finalidades (SIM/blank) ===
      const yes = v => {
        const t = String(v ?? '').trim().toUpperCase();
        return !!t && !['NÃO','NAO','NO','0','FALSE','F'].includes(t);
      };

      // “adesão sem irregularidades”
      const adesaoSemIrreg = data?.ADESAO_SEM_IRREGULARIDADES ?? crp?.adesao_sem_irregulares ?? '';
      const chkSemIrreg = $('#chkSemIrregularidades');
      if (chkSemIrreg) chkSemIrreg.checked = yes(adesaoSemIrreg);

      // Demais colunas 3.2
      [
        ['MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS','input[name="MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS"]'],
        ['DEFICIT_ATUARIAL','input[name="DEFICIT_ATUARIAL"]'],
        ['CRITERIOS_ESTRUT_ESTABELECIDOS','input[name="CRITERIOS_ESTRUT_ESTABELECIDOS"]'],
        ['OUTRO_CRITERIO_COMPLEXO','input[name="OUTRO_CRITERIO_COMPLEXO"]'],
      ].forEach(([col, sel])=>{
        const v = data?.[col] ?? crp?.[col] ?? '';
        const inp = document.querySelector(sel);
        if (inp) inp.checked = yes(v);
      });

      // 1.1 Esfera
      const esfera = (data?.esfera || ente?.esfera || '').trim();
      if (esfera) {
        if (/municipal/i.test(esfera)) { if (el.esfMun) el.esfMun.checked = true; if (el.esfEst) el.esfEst.checked = false; }
        else if (/estadual|distrital/i.test(esfera)) { if (el.esfEst) el.esfEst.checked = true; if (el.esfMun) el.esfMun.checked = false; }
      }

      popularListasFaseComBaseNosCritérios();
      saveState();
      dbg('[hidratarTermosRegistrados] done ✓');

    }catch(err){
      dbe('[hidratarTermosRegistrados] falhou:', err);
      // Fallback mínimo p/ não travar
      if (!el.uf.value && el.spanUfGescon?.textContent) el.uf.value = el.spanUfGescon.textContent.trim();
      if (!el.ente.value && el.spanEnteGescon?.textContent) el.ente.value = el.spanEnteGescon.textContent.trim();
      if (!el.cnpjEnte.value) el.cnpjEnte.value = maskCNPJ(cnpj);

      popularListasFaseComBaseNosCritérios();
      saveState();
      const introNG = document.getElementById('intro_N_GESCON');
      const introDT = document.getElementById('intro_DATA_ENC');
      if (introNG) introNG.textContent = el.spanNGescon?.textContent || '—';
      if (introDT) introDT.textContent = el.spanDataEnc?.textContent || '—';

    }
  }




  /* ========= Fase 4 (mostrar blocos + validar) ========= */
  function setupFase4Toggles(){
    // mapa: valor do checkbox da fase -> id do modal correspondente
    const modalByFase = {
      '4.1': 'modalF41',
      '4.2': 'modalF42',
      '4.3': 'modalF43',
      '4.4': 'modalF44',
      '4.5': 'modalF45',
      '4.6': 'modalF46'
    };

    // Ao marcar uma fase, abre o modal (não limpa nada ao fechar)
    el.faseChecks.forEach(chk=>{
      chk.addEventListener('change', ()=>{
        const target = modalByFase[chk.value];
        if (chk.checked && target) {
          const m = document.getElementById(target);
          if (m) bootstrap.Modal.getOrCreateInstance(m).show();
        }
        saveState();
      });
    });

    // Nada de mostrar/ocultar blocos na página — ficam só dentro dos modais
  }

  /* === Condicionais dos modais === */
  function bindCondicionais() {
    // 4.3.10 A/B
    $$('.form-check-input[name="F4310_OPCAO"]').forEach(r => {
      r.addEventListener('change', () => {
        const a = document.getElementById('F4310_LEGISLACAO_WRAP');
        const b = document.getElementById('F4310_DOCS_WRAP');
        const val = document.querySelector('input[name="F4310_OPCAO"]:checked')?.value;
        if (a) a.classList.toggle('d-none', val !== 'A');
        if (b) b.classList.toggle('d-none', val !== 'B');
      });
    });

    // 4.3.12 – só mostra lista se solicitar inclusão
    const chkIncl = document.getElementById('F43_SOLICITA_INCLUSAO');
    const wrapIncl = document.getElementById('F43_INCLUSAO_WRAP');
    if (chkIncl && wrapIncl) {
      const toggle = () => wrapIncl.classList.toggle('d-none', !chkIncl.checked);
      chkIncl.addEventListener('change', () => { toggle(); saveState(); });
      toggle();
    }

    // 4.4.1 (d) legislação
    const optD = document.getElementById('F441_OPTD');
    const lWrap = document.getElementById('F441_LEGISLACAO_WRAP');
    if (optD && lWrap) optD.addEventListener('change', () => lWrap.classList.toggle('d-none', !optD.checked));

    // 4.4.2 (e) abre critérios
    const optE = document.getElementById('F442_OPTE');
    const critWrap44 = document.getElementById('F44_CRIT_WRAP');
    if (optE && critWrap44) optE.addEventListener('change', () => critWrap44.classList.toggle('d-none', !optE.checked));

    // 4.6.2 (f) abre critérios
    const optF = document.getElementById('F462F_OPTF');
    const critWrap46 = document.getElementById('F462F_WRAP');
    if (optF && critWrap46) optF.addEventListener('change', () => critWrap46.classList.toggle('d-none', !optF.checked));
  }


  function validarFaseSelecionada(){
    const fases = $$('.fase-check:checked').map(i=>i.value);
    if(!fases.length) return { ok:false, motivo:'Selecione ao menos uma fase (4.1 a 4.6).' };

    for (const f of fases){
      if (f==='4.1'){
        const opt = $('input[name="F41_OPCAO"]:checked', el.blk41);
        if(!opt) return { ok:false, motivo:'Na fase 4.1, selecione 4.1.1 ou 4.1.2.' };
      }
      if (f==='4.2'){
        const marc = $$('input[type="checkbox"]:checked', el.f42Lista);
        if(!marc.length) return { ok:false, motivo:'Na fase 4.2, marque ao menos um item (a–i).' };
      }
      if (f==='4.3'){
        const marc = $$('input[type="checkbox"]:checked', el.f43Lista);
        const just = ($('#F43_JUST')?.value||'').trim();
        if(!marc.length && !just) return { ok:false, motivo:'Na fase 4.3, marque ao menos um critério ou preencha as justificativas.' };
      }
      if (f==='4.4'){
        const optE = document.getElementById('F442_OPTE');
        if (optE?.checked) {
          const crits = $$('#F44_CRITERIOS input[type="checkbox"]:checked');
          if (!crits.length) {
            return { ok:false, motivo:'Na 4.4, ao marcar a finalidade “e)”, selecione pelo menos um critério em 4.4.3.' };
          }
        }
      } // <-- ESSA CHAVE FALTAVA

      if (f==='4.5'){
        const ok451 = $('#blk_45 input[type="checkbox"]:checked');
        const docs = ($('#F45_DOCS')?.value||'').trim();
        const jus  = ($('#F45_JUST')?.value||'').trim();
        if(!ok451 && !docs && !jus) {
          return { ok:false, motivo:'Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas.' };
        }
      }
      if (f==='4.6'){
        const crits = $$('input[type="checkbox"]:checked', el.f46Crits);
        const nivel = $('#F46_PROGESTAO')?.value || '';
        const porte = $('#F46_PORTE')?.value || '';
        if(!crits.length) return { ok:false, motivo:'Na fase 4.6, selecione ao menos um critério em 4.6.1.' };
        if(!nivel || !porte) return { ok:false, motivo:'Informe nível Pró-Gestão e Porte ISP-RPPS em 4.6.1 (b/c).' };
      }
    }
    return { ok:true };
  }
  function popularListasFaseComBaseNosCritérios(){
    if(!el.grpCrit) return;
    const itens = $$('input[name="CRITERIOS_IRREGULARES[]"]', el.grpCrit).map(inp => ({
      value: inp.value,
      label: inp.nextElementSibling ? inp.nextElementSibling.textContent : inp.value
    }));

    // 4.3.11(a) – incluir no Plano da Fase Específica
    const f43Incl = document.getElementById('F43_INCLUIR');
    if (f43Incl && !f43Incl.children.length){
      f43Incl.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    // 4.3 – lista dos critérios regulares na fase intermediária
    if (el.f43Lista && !el.f43Lista.children.length){
      el.f43Lista.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    if(el.f44Crits && !el.f44Crits.children.length){
      el.f44Crits.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }
    if(el.f44Final && !el.f44Final.children.length){
      const finals = [
        'Implementação do plano de equacionamento do déficit atuarial',
        'Prazos adicionais para comprovação de medidas',
        'Plano de equacionamento alternativo (art. 55, § 7º, Portaria 1.467/2022)',
        'Adequação da Unidade Gestora Única (CF, art. 40, § 20)',
        'Organização do RPPS / cumprimento de critério estruturante (especificar)'
      ];
      el.f44Final.innerHTML = finals.map(txt => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${txt}"><span class="form-check-label">${txt}</span></label>`
      )).join('');
    }
    if(el.f46Crits && !el.f46Crits.children.length){
      el.f46Crits.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }
    if(el.f46Final && !el.f46Final.children.length){
      el.f46Final.innerHTML = el.f44Final.innerHTML;
    }
    // 4.6.2 (f) – critérios completos
    const f462f = document.getElementById('F462F_CRITERIOS');
    if (f462f && !f462f.children.length) {
      f462f.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }
  }

  /* ========= Validação geral (mínimos) ========= */
  function validarCamposBasicos(){
    const msgs=[];
    // 1.2 / 1.3
    if(!el.uf.value.trim()) msgs.push('UF');
    if(!el.ente.value.trim()) msgs.push('Ente');
    if(digits(el.cnpjEnte.value).length!==14) msgs.push('CNPJ do Ente');
    if(!isEmail(el.emailEnte.value)) msgs.push('E-mail do Ente');
    if(!el.ug.value.trim()) msgs.push('Unidade Gestora');
    if(digits(el.cnpjUg.value).length!==14) msgs.push('CNPJ da UG');
    if(!isEmail(el.emailUg.value)) msgs.push('E-mail da UG');

    // 2
    if(digits(el.cpfRepEnte.value).length!==11) msgs.push('CPF do Rep. do Ente');
    if(!el.nomeRepEnte.value.trim()) msgs.push('Nome do Rep. do Ente');
    if(!el.cargoRepEnte.value.trim()) msgs.push('Cargo do Rep. do Ente');
    if(!isEmail(el.emailRepEnte.value)) msgs.push('E-mail do Rep. do Ente');

    if(digits(el.cpfRepUg.value).length!==11) msgs.push('CPF do Rep. da UG');
    if(!el.nomeRepUg.value.trim()) msgs.push('Nome do Rep. da UG');
    if(!el.cargoRepUg.value.trim()) msgs.push('Cargo do Rep. da UG');
    if(!isEmail(el.emailRepUg.value)) msgs.push('E-mail do Rep. da UG');

    // 3


    // 3.3 (opcional marcar nenhum, então não obriga)

    if(msgs.length){ showAtencao(['Preencha os campos:', ...msgs.map(m=>'• '+m)]); return false; }
    return true;
  }

  /* ========= Carimbos ========= */
  function fillNowHiddenFields(){
    const now = new Date();
    el.mes.value    = String(now.getMonth()+1).padStart(2,'0');
    el.dataSol.value= fmtBR(now);
    el.horaSol.value= fmtHR(now);
    el.anoSol.value = String(now.getFullYear());
  }

  /* ========= Payload ========= */
  function buildPayload(){
    const ESFERA =
      (el.esfMun?.checked ? 'RPPS Municipal' :
      (el.esfEst?.checked ? 'Estadual/Distrital' : ''));

    const marcadas   = $$('.fase-check:checked').map(i=>i.value);
    const faseCompat = marcadas.sort().slice(-1)[0] || '';

    // 3.2
    const ADESAO_SEM_IRREGULARIDADES =
      $('#chkSemIrregularidades')?.checked ? 'SIM' : '';
    const FIN_3_2_MANUTENCAO_CONFORMIDADE =
      document.querySelector('input[name="MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS"]')?.checked ? 'SIM' : '';
    const FIN_3_2_DEFICIT_ATUARIAL =
      document.querySelector('input[name="DEFICIT_ATUARIAL"]')?.checked ? 'SIM' : '';
    const FIN_3_2_CRITERIOS_ESTRUTURANTES =
      document.querySelector('input[name="CRITERIOS_ESTRUT_ESTABELECIDOS"]')?.checked ? 'SIM' : '';
    const FIN_3_2_OUTRO_CRITERIO_COMPLEXO =
      document.querySelector('input[name="OUTRO_CRITERIO_COMPLEXO"]')?.checked ? 'SIM' : '';

    // Campos do CRP anterior podem não existir neste formulário
    const DATA_VENCIMENTO_ULTIMO_CRP = (el.dataUltCrp?.value) || '';
    const TIPO_EMISSAO_ULTIMO_CRP =
      (el.tipoAdm?.checked && 'Administrativa') ||
      (el.tipoJud?.checked && 'Judicial') || '';

    return {
      HAS_TERMO_ENC_GESCON: el.hasGescon?.value === '1',
      N_GESCON: el.spanNGescon?.textContent || '',
      DATA_ENC_VIA_GESCON: el.spanDataEnc?.textContent || '',

      // 1) Identificação
      ESFERA,
      UF: el.uf.value.trim(),
      ENTE: el.ente.value.trim(),
      CNPJ_ENTE: digits(el.cnpjEnte.value),
      EMAIL_ENTE: el.emailEnte.value.trim(),
      UG: el.ug.value.trim(),
      CNPJ_UG: digits(el.cnpjUg.value),
      EMAIL_UG: el.emailUg.value.trim(),

      // 2) Representantes
      CPF_REP_ENTE: digits(el.cpfRepEnte.value),
      NOME_REP_ENTE: el.nomeRepEnte.value.trim(),
      CARGO_REP_ENTE: el.cargoRepEnte.value.trim(),
      EMAIL_REP_ENTE: el.emailRepEnte.value.trim(),
      TEL_REP_ENTE: el.telRepEnte.value.trim(),
      CPF_REP_UG: digits(el.cpfRepUg.value),
      NOME_REP_UG: el.nomeRepUg.value.trim(),
      CARGO_REP_UG: el.cargoRepUg.value.trim(),
      EMAIL_REP_UG: el.emailRepUg.value.trim(),
      TEL_REP_UG: el.telRepUg.value.trim(),

      // 3) CRP anterior (opcionais no form_2)
      DATA_VENCIMENTO_ULTIMO_CRP,
      TIPO_EMISSAO_ULTIMO_CRP,

      // 3.1
      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i => i.value),

      // 3.2
      ADESAO_SEM_IRREGULARIDADES,
      FIN_3_2_MANUTENCAO_CONFORMIDADE,
      FIN_3_2_DEFICIT_ATUARIAL,
      FIN_3_2_CRITERIOS_ESTRUTURANTES,
      FIN_3_2_OUTRO_CRITERIO_COMPLEXO,

      // 4) Fases
      FASES_MARCADAS: marcadas,
      FASE_PROGRAMA: faseCompat,
      F41_OPCAO: $('input[name="F41_OPCAO"]:checked')?.value || '',
      F42_LISTA: $$(`#F42_LISTA input[type="checkbox"]:checked`).map(i => i.value),
      F43_LISTA: $$(`#F43_LISTA input[type="checkbox"]:checked`).map(i => i.value),
      F43_JUST:  $('#F43_JUST')?.value || '',
      F43_PLANO: $('#F43_PLANO')?.value || '',
      F43_INCLUIR: $$('#F43_INCLUIR input[type="checkbox"]:checked').map(i => i.value),
      F44_CRITERIOS:   $$(`#F44_CRITERIOS input[type="checkbox"]:checked`).map(i => i.value),
      F44_DECLS:       $$(`#blk_44 .d-flex input[type="checkbox"]:checked`).map(i => i.value),
      F44_FINALIDADES: $$(`#F44_FINALIDADES input[type="checkbox"]:checked`).map(i => i.value),
      F44_ANEXOS:      $('#F44_ANEXOS')?.value || '',
      F45_OK451: !!$('#blk_45 input[type="checkbox"]:checked'),
      F45_DOCS:  $('#F45_DOCS')?.value || '',
      F45_JUST:  $('#F45_JUST')?.value || '',
      F46_CRITERIOS:   $$(`#F46_CRITERIOS input[type="checkbox"]:checked`).map(i => i.value),
      F46_PROGESTAO:   $('#F46_PROGESTAO')?.value || '',
      F46_PORTE:       $('#F46_PORTE')?.value || '',
      F46_JUST_D:      $('#F46_JUST_D')?.value || '',
      F46_DOCS_D:      $('#F46_DOCS_D')?.value || '',
      F46_JUST_E:      $('#F46_JUST_E')?.value || '',
      F46_DOCS_E:      $('#F46_DOCS_E')?.value || '',
      F46_FINALIDADES: $$(`#F46_FINALIDADES input[type="checkbox"]:checked`).map(i => i.value),
      F46_ANEXOS:      $('#F46_ANEXOS')?.value || '',
      F46_JUST_PLANOS: $('#F46_JUST_PLANOS')?.value || '',
      F46_COMP_CUMPR:  $('#F46_COMP_CUMPR')?.value || '',

      // 4.3.10
      F4310_OPCAO:  document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '',
      F4310_LEGISLACAO: $('#F4310_LEGISLACAO')?.value || '',
      F4310_DOCS:       $('#F4310_DOCS')?.value || '',

      // 4.3.12
      F43_DESC_PLANOS: $('#F43_DESC_PLANOS')?.value || '',

      // 4.4 extras
      F441_LEGISLACAO: $('#F441_LEGISLACAO')?.value || '',
      F445_DESC_PLANOS: $('#F445_DESC_PLANOS')?.value || '',
      F446_DOCS:       $('#F446_DOCS')?.value || '',
      F446_EXEC_RES:   $('#F446_EXEC_RES')?.value || '',

      // 4.5.3
      F453_EXEC_RES: $('#F453_EXEC_RES')?.value || '',

      // 4.6 extras
      F462F_CRITERIOS: $$('#F462F_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value),
      F466_DOCS:      $('#F466_DOCS')?.value || '',
      F466_EXEC_RES:  $('#F466_EXEC_RES')?.value || '',


      // 5
      JUSTIFICATIVAS_GERAIS: el.justGerais?.value || '',

      // Carimbos
      MES: el.mes.value,
      DATA_SOLIC_GERADA: el.dataSol.value,
      HORA_SOLIC_GERADA: el.horaSol.value,
      ANO_SOLIC_GERADA: el.anoSol.value,

      // Idempotência
      IDEMP_KEY: takeIdemKey() || ''
    };
  }
  /* ========= Fluxo ÚNICO de PDF ========= */
  async function gerarBaixarPDF(payload){
    // 👇 converte apenas para o endpoint de PDF
    const payloadForPdf = {
      ...payload,
      HAS_TERMO_ENC_GESCON: payload.HAS_TERMO_ENC_GESCON ? '1' : ''
    };

    const blob = await fetchBinary(
      api('/termo-solic-crp-pdf'), // rota existente no server (via /_api/)
      {
        method: 'POST',
        headers: withKey({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payloadForPdf) // << usa o payload convertido
      },
      { label: 'termo-solic-crp-pdf', timeout: 60000, retries: 1 }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const enteSlug = String(payload.ENTE || 'solic-crp')
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
      .toLowerCase();
    a.href = url; a.download = `solic-crp-${enteSlug}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }


  /* ========= Ações: Gerar & Submit ========= */
  let gerarBusy=false;
  el.btnGerar?.addEventListener('click', async ()=>{
    if(gerarBusy) return;
    if(!validarCamposBasicos()) return;
    const vf = validarFaseSelecionada(); if(!vf.ok){ showAtencao([vf.motivo]); return; }

    gerarBusy=true; el.btnGerar.disabled=true;
    try{
      fillNowHiddenFields();
      const payload = buildPayload();
      const md = bootstrap.Modal.getOrCreateInstance($('#modalGerandoPdf')); md.show();
      await gerarBaixarPDF(payload);
      md.hide();
      bootstrap.Modal.getOrCreateInstance($('#modalSucesso')).show();
    }catch(e){
      bootstrap.Modal.getOrCreateInstance($('#modalGerandoPdf')).hide();
      showErro(friendlyErrorMessages(e,'Não foi possível gerar o PDF.'));
    }finally{
      el.btnGerar.disabled=false; gerarBusy=false;
    }
  });

  const form = $('#solicCrpForm');
  form?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if(!validarCamposBasicos()) return;
    const vf = validarFaseSelecionada(); if(!vf.ok){ showAtencao([vf.motivo]); return; }

    fillNowHiddenFields();

    const idem = takeIdemKey() || newIdemKey();
    rememberIdemKey(idem);

    const payload = buildPayload(); // já inclui IDEMP_KEY (se existir)

    const btn = el.btnSubmit; const old = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = 'Finalizando…';

    // abre “Salvando…” se demorar
    let t = setTimeout(()=> bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).show(), 3000);

    try{
      await fetchJSON(api('/gerar-solic-crp'), {
      method:'POST',
      headers: withKey({'Content-Type':'application/json','X-Idempotency-Key':idem}),
      body: JSON.stringify(payload)
      }, { label:'gerar-solic-crp', timeout:30000, retries:1 });

      clearTimeout(t);
      try{ bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); }catch{}
      clearIdemKey();
      btn.innerHTML = 'Finalizado ✓';
      
      // limpar formulário e estado
      setTimeout(()=>{
        try{ form.reset(); }catch{}
        clearAllState();

        // Zera gate do Gescon e limpa visual
        el.hasGescon && (el.hasGescon.value = '0');
        el.cnpjInput && (el.cnpjInput.value = '');
        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.spanNGescon) el.spanNGescon.textContent = '';
        if (el.spanDataEnc) el.spanDataEnc.textContent = '';
        if (el.spanUfGescon) el.spanUfGescon.textContent = '';
        if (el.spanEnteGescon) el.spanEnteGescon.textContent = '';
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';

        // Bloqueia novamente o "Próximo" até nova pesquisa válida
        if (el.btnNext) el.btnNext.disabled = true;

        btn.disabled=false; btn.innerHTML=old;

        // Volta para o passo 0 e re-renderiza
        curStep = 0;
        window.__renderStepper?.();

      }, 800);

    }catch(err){
      clearTimeout(t);
      try{ bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); }catch{}
      showErro(friendlyErrorMessages(err, 'Falha ao registrar a solicitação.'));
      // mantém idemKey p/ reenvio
      btn.disabled=false; btn.innerHTML=old;
    }
  });
  /* ========= UI helpers ========= */
  function showModal(id){ const mEl=document.getElementById(id); if(!mEl) return; bootstrap.Modal.getOrCreateInstance(mEl).show(); }
  function initWelcome(){
    const mw = $('#modalWelcome');
    if(mw){ setTimeout(()=> bootstrap.Modal.getOrCreateInstance(mw).show(), 150); }
  }

  // Versão única de showErro (mantida)
  function showErro(msgs) {
    try {
      const ul = document.getElementById('modalErroLista');
      if (ul) {
        ul.innerHTML = (Array.isArray(msgs) ? msgs : [String(msgs||'Ocorreu um erro.')])
          .map(m => `<li>${m}</li>`).join('');
      }
      const el = document.getElementById('modalErro');
      if (el && window.bootstrap) bootstrap.Modal.getOrCreateInstance(el).show();
    } catch {}
  }

  /* ========= Boot ========= */
  function init(){
    bindMasks();
    el.btnPesquisar?.addEventListener('click', onPesquisar, false);
    setupFase4Toggles();
    bindCondicionais();
    const faseSel = document.querySelector('input[name="FASE_PROGRAMA"]:checked');
    if (faseSel) faseSel.dispatchEvent(new Event('change'));
    popularListasFaseComBaseNosCritérios();
    initWelcome();

    // exclusividade esfera
    $$('.esf-only-one').forEach(chk=>{
      chk.addEventListener('change', ()=>{
        if(chk.checked) $$('.esf-only-one').forEach(o=>{ if(o!==chk) o.checked=false; });
        saveState();
      });
    });

    // salvar alterou
    const form = $('#solicCrpForm');
    form?.addEventListener('input', ()=> setTimeout(saveState, 300));
    form?.addEventListener('change', ()=> setTimeout(saveState, 300));

    // Step 0: começa desabilitado até achar Gescon
    if(el.btnNext) el.btnNext.disabled = true;

    // restore & stepper
    ensureStepperFallback();
    window.addEventListener('beforeunload', saveState);
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
  else{ init(); }
})();
