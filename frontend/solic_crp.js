// solic_crp.js — fluxo completo da Solicitação de CRP Emergencial (isolado da Adesão)

(() => {

  // === DEBUG global (ligue/desligue quando quiser) ===
  window.__DEBUG_SOLIC_CRP__ = true;
  function dbg(...args){ if (window.__DEBUG_SOLIC_CRP__) console.log(...args); }
  function dbe(...args){ if (window.__DEBUG_SOLIC_CRP__) console.error(...args); }

  /* ========= Config ========= */
  const API_BASE = (function(){
    // permite sobrescrever via window.__API_BASE se quiser
    const override = (window.__API_BASE && String(window.__API_BASE).replace(/\/+$/, '')) || '';
    return override || '/.netlify/functions/api-proxy';
  })();
  const api = (p) => `${API_BASE}${p.startsWith('/') ? p : '/' + p}`;

  // (opcional) chave para o backend
  const API_KEY = window.__API_KEY || '';
  const withKey = (h = {}) => (API_KEY ? { ...h, 'X-API-Key': API_KEY } : h)

  // === Warmup/Health do backend ===
  // Verifica /_api/health por até 60s para evitar cold start antes dos POSTs pesados
  async function waitForService({ timeoutMs = 60000, pollMs = 1500 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const r = await fetchJSON('/_api/health', {}, { label: 'health', timeout: 4000, retries: 0 });
          if (r && (r.ok || r.status === 'ok')) return true;
        } catch (_) {}
        await new Promise(r => setTimeout(r, pollMs));
      }
      return false;
  }

  const FORM_STORAGE_KEY = 'solic-crp-form-v1';
  const IDEM_STORE_KEY   = 'rpps-idem-submit:solic-crp';
  const FORM_TTL_MS      = 30 * 60 * 1000;              // 30 min

  /* ========= Utils ========= */
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
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
          (isHttp && (e.status===429 || e.status===502 || e.status===503 || e.status===504 || e.status>=500)) ||
          m.includes('timeout:') || !navigator.onLine || m.includes('failed');
        if(retriable && attempt <= (retries+1)){
          const backoff = Math.min(5000, 400 * Math.pow(2, attempt-1));
          await new Promise(r=>setTimeout(r, backoff));
          continue;
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
    infoProcSei:  $('#INFO_PROC_SEI'),
    introNGescon: $('#INTRO_N_GESCON'),
    introDataEnc: $('#INTRO_DATA_ENC'),
    introProcSei: $('#INTRO_PROC_SEI'),

    // etapa 1
    uf: $('#UF'), ente: $('#ENTE'), cnpjEnte: $('#CNPJ_ENTE'), emailEnte: $('#EMAIL_ENTE'),
    ug: $('#UG'), cnpjUg: $('#CNPJ_UG'), emailUg: $('#EMAIL_UG'),
    // >>> adicionados (1.3.2 – espelham 1.3):
    ugNome:  $('#ug_nome'),
    ugCnpj:  $('#ug_cnpj'),
    ugEmail: $('#ug_email'),
    // <<<
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
    faseRadios: $$('input[name="FASE_PROGRAMA"]'),
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

  //Captura robusta do CNPJ_UG (sem fallback para zeros) — agora usada na validação e no payload
  function obterCNPJUG() {
    const candidatos = [
      document.getElementById('CNPJ_UG')?.value,
      document.getElementById('ug_cnpj')?.value,
      el.cnpjUg?.value,
      el.ugCnpj?.value
    ].filter(Boolean);

    const limpo = candidatos
      .map(v => String(v).replace(/\D/g, ''))
      .find(v => v && v.length === 14);

    return limpo || null;
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

  // === 1.3 → 1.3.2 (espelhamento automático) ===
  function syncUg132() {
    if (!el.ug || !el.cnpjUg || !el.emailUg) return;
    if (el.ugNome)  el.ugNome.value  = el.ug.value || '';
    if (el.ugCnpj)  el.ugCnpj.value  = el.cnpjUg.value || '';
    if (el.ugEmail) el.ugEmail.value = el.emailUg.value || '';
  }
  function bindSyncUg132(){
    ['input','change'].forEach(evt=>{
      el.ug     && el.ug.addEventListener(evt, syncUg132);
      el.cnpjUg && el.cnpjUg.addEventListener(evt, syncUg132);
      el.emailUg&& el.emailUg.addEventListener(evt, syncUg132);
    });
    // dispara uma vez na carga
    syncUg132();
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
      'ug_nome','ug_cnpj','ug_email',
      'CPF_REP_ENTE','NOME_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE',
      'CPF_REP_UG','NOME_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG',
      'JUSTIFICATIVAS_GERAIS'
    ].forEach(id=>{ const e=$('#'+id); if(e) data.values[id]=e.value; });
    data.values['esf_mun'] = !!el.esfMun?.checked;
    data.values['esf_est'] = !!el.esfEst?.checked;

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

    // fase selecionada (radio)
    const faseSel = $('input[name="FASE_PROGRAMA"]:checked');
    data.values['FASE_PROGRAMA'] = faseSel?.value || '';

    // 4.1
    const f41 = $('input[name="F41_OPCAO"]:checked'); data.values['F41_OPCAO'] = f41?.value||'';

    // 4.2
    data.values['F42_LISTA[]'] = $$(`#F42_LISTA input[type="checkbox"]:checked`).map(i=>i.value);

    // 4.3
    data.values['F43_LISTA[]'] = $$(`#F43_LISTA input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F43_PLANO']   = $('#F43_PLANO')?.value || '';
    data.values['F43_INCLUIR[]'] = $$('#F43_INCLUIR input[type="checkbox"]:checked').map(i=>i.value);
    data.values['F43_SOLICITA_INCLUSAO'] = !!$('#F43_SOLICITA_INCLUSAO')?.checked;
    data.values['F43_PLANO_B'] = $('#F43_PLANO_B')?.value || '';
    data.values['F43_DESC_PLANOS'] = $('#F43_DESC_PLANOS')?.value || '';

    // 4.3.10
    data.values['F4310_OPCAO']      = document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '';
    data.values['F4310_LEGISLACAO'] = $('#F4310_LEGISLACAO')?.value || '';
    data.values['F4310_DOCS']       = $('#F4310_DOCS')?.value || '';

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

    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(data));
  }


  // --- MIGRAÇÃO: puxa dados salvos no formulário 1 (rpps-form-v1) ---
  // Se existir rpps-form-v1 e ainda não houver solic-crp-form-v1, copia o essencial.
  function migrateFromAdesaoIfNeeded() {
    try {
      const DEST_KEY = FORM_STORAGE_KEY;            // 'solic-crp-form-v1'
      const SRC_KEY  = 'rpps-form-v1';              // usado pelo form 1 (script.js)

      if (localStorage.getItem(DEST_KEY)) return null;   // já existe o destino
      const raw = localStorage.getItem(SRC_KEY);
      if (!raw) return null;

      const st   = JSON.parse(raw) || {};
      const vals = st.values || {};

      // Mapeamento dos campos equivalentes entre os formulários
      const mapped = {
        UF:           vals.UF,
        ENTE:         vals.ENTE,
        CNPJ_ENTE:    vals.CNPJ_ENTE,
        EMAIL_ENTE:   vals.EMAIL_ENTE,

        // 1.3  ↔  1.3.2 (mantém compatibilidade nos dois conjuntos de ids)
        UG:           vals.UG || vals.ug_nome,
        CNPJ_UG:      vals.CNPJ_UG || vals.ug_cnpj,
        EMAIL_UG:     vals.EMAIL_UG || vals.ug_email,

        ug_nome:      vals.ug_nome || vals.UG,
        ug_cnpj:      vals.ug_cnpj || vals.CNPJ_UG,
        ug_email:     vals.ug_email || vals.EMAIL_UG,

        // Situação do RPPS / Esfera (quando existirem)
        rpps_situacao: vals.rpps_situacao || vals['rpps_situacao'],
        esf_mun:       !!vals.esf_mun,
        esf_est:       !!vals.esf_est
      };

      const next = {
        step: 1,
        values: mapped,
        lastSaved: Date.now(),
        finalizedAt: 0
      };
      localStorage.setItem(DEST_KEY, JSON.stringify(next));
      return next;
    } catch (e) {
      // silencioso por segurança
      return null;
    }
  }


  function loadState(){
  try{
    let raw = localStorage.getItem(FORM_STORAGE_KEY); // 'solic-crp-form-v1'
    if (!raw) {
      // tenta migrar automaticamente do formulário 1
      const migrated = migrateFromAdesaoIfNeeded();
      raw = localStorage.getItem(FORM_STORAGE_KEY) || null;
    }
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

      // 4 (fase radio)
      (function() {
        const v = st.values?.['FASE_PROGRAMA'] || '';
        if (v) {
          const r = document.querySelector(`input[name="FASE_PROGRAMA"][value="${v}"]`);
          if (r) r.checked = true;
        }
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

      const nGescon = data?.n_gescon || '';
      let dataEnc   = data?.data_enc_via_gescon ?? data?.data_encaminhamento ?? data?.data_enc ?? data?.data ?? '';
      const procSei = data?.proc_sei ?? data?.processo_sei ?? '';

      let ok = !!(nGescon && data?.uf && data?.ente && dataEnc);
      if (ok && !isGesconNumber(nGescon)) {
        console.warn('Número Gescon com formato inválido:', nGescon);
        ok = false;
      }

      if (!ok) {
        dbg('Sem registro válido Gescon → desbloqueando fluxo e tentando hidratar termos…');
        el.hasGescon && (el.hasGescon.value = '0');
        if (el.btnNext) el.btnNext.disabled = false;

        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';
        const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = '—';

        if (el.introNGescon) el.introNGescon.textContent = (nGescon || '—');
        if (el.introDataEnc) el.introDataEnc.textContent = (toDateBR(dataEnc) || '—');
        if (el.introProcSei) el.introProcSei.textContent = (procSei || '—');
        if (el.infoProcSei)  el.infoProcSei.textContent  = (procSei || '—');

        preencherRegistrosDoTermo({
          gescon_consulta: nGescon || '—',
          data_encaminhamento: toDateBR(dataEnc) || '—',
          processo_sei: procSei || '—'
        });

        try { await hidratarTermosRegistrados(cnpj); } catch (e) { dbe('hidratarTermosRegistrados falhou (sem bloqueio):', e); }
        if (curStep === 0) { curStep = 1; window.__renderStepper?.(); }
        console.groupEnd();
        return;
      }

      // ✅ registro encontrado
      const dataEncBR = toDateBR(dataEnc);
      el.hasGescon && (el.hasGescon.value = '1');
      if (el.btnNext) el.btnNext.disabled = false;

      el.spanNGescon && (el.spanNGescon.textContent = nGescon || '');
      el.spanDataEnc && (el.spanDataEnc.textContent = dataEncBR || '');
      el.spanUfGescon && (el.spanUfGescon.textContent = data.uf || '');
      el.spanEnteGescon && (el.spanEnteGescon.textContent = data.ente || '');
      el.infoProcSei && (el.infoProcSei.textContent = procSei || '—');
      el.boxGescon?.classList.remove('d-none');

      // Preencher o bloco introdutório (se existir)
      const introNG = document.getElementById('intro_N_GESCON');
      const introDT = document.getElementById('intro_DATA_ENC');
      if (introNG) introNG.textContent = nGescon || '—';
      if (introDT) introDT.textContent = dataEncBR || '—';

      el.infoDataEncGescon && (el.infoDataEncGescon.textContent = dataEncBR || '—');
      const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = nGescon || '—';

      preencherRegistrosDoTermo({
        gescon_consulta: nGescon || '—',
        data_encaminhamento: dataEncBR || '—',
        processo_sei: procSei || '—'
      });

      dbg('Chamando hidratarTermosRegistrados…');
      await hidratarTermosRegistrados(cnpj);
      dbg('hidratarTermosRegistrados → OK');

      // garante espelhamento 1.3 → 1.3.2 após hidratar
      syncUg132();

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

      // >>> NOVO: espelha 1.3 → 1.3.2
      syncUg132();
      // <<<

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

      // Fallback: se algum campo da UG ficou vazio, reforça com dados do "Formulário 1"
      if (!el.ug.value && ente.ug)            el.ug.value      = ente.ug;
      if (!el.cnpjUg.value && ente.cnpj_ug)   el.cnpjUg.value   = maskCNPJ(ente.cnpj_ug);
      if (!el.emailUg.value && ente.email_ug) el.emailUg.value  = ente.email_ug;

      // >>> NOVO: Processo SEI visível no quadro do passo 0 (se vier da planilha/API)
      const procSei = data?.proc_sei ?? data?.PROCESSO_SEI ?? '';
      if (procSei && el.infoProcSei) el.infoProcSei.textContent = procSei;
      // <<<

      popularListasFaseComBaseNosCritérios();
      saveState();
      dbg('[hidratarTermosRegistrados] done ✓');

    }catch(err){
      dbe('[hidratarTermosRegistrados] falhou:', err);
      // Fallback mínimo p/ não travar
      if (!el.uf.value && el.spanUfGescon?.textContent) el.uf.value = el.spanUfGescon.textContent.trim();
      if (!el.ente.value && el.spanEnteGescon?.textContent) el.ente.value = el.spanEnteGescon.textContent.trim();
      if (!el.cnpjEnte.value) el.cnpjEnte.value = maskCNPJ(cnpj);

      // mantém listas e estado
      popularListasFaseComBaseNosCritérios();
      saveState();
      const introNG = document.getElementById('intro_N_GESCON');
      const introDT = document.getElementById('intro_DATA_ENC');
      if (introNG) introNG.textContent = el.spanNGescon?.textContent || '—';
      if (introDT) introDT.textContent = el.spanDataEnc?.textContent || '—';

      // garante espelhamento
      syncUg132();
    }
  }

  /* ========= Fase 4 (mostrar blocos + validar) ========= */
  function setupFase4Toggles(){
    const modalByFase = {
      '4.1': 'modalF41',
      '4.2': 'modalF42',
      '4.3': 'modalF43',
      '4.4': 'modalF44',
      '4.5': 'modalF45',
      '4.6': 'modalF46'
    };
    // abrir modal ao selecionar radio (seleção única)
    el.faseRadios.forEach(r=>{
      r.addEventListener('change', ()=>{
        const target = modalByFase[r.value];
        if (r.checked && target) {
          const m = document.getElementById(target);
          if (m) bootstrap.Modal.getOrCreateInstance(m).show();
        }
        // habilita Próximo ao escolher a fase (coerente com HTML)
        if (el.btnNext) el.btnNext.disabled = false;
        saveState();
      });
    });
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
    const f = document.querySelector('input[name="FASE_PROGRAMA"]:checked')?.value || '';
    if(!f) return { ok:false, motivo:'Selecione a fase do Programa (4.1 a 4.6).' };

    if (f==='4.1'){
      const opt = $('input[name="F41_OPCAO"]:checked', el.blk41);
      if(!opt) return { ok:false, motivo:'Na fase 4.1, selecione 4.1.1 ou 4.1.2.' };
    }
    if (f==='4.2'){
      const marc = $$('input[type="checkbox"]:checked', el.f42Lista);
      if(!marc.length) return { ok:false, motivo:'Na fase 4.2, marque ao menos um item (a–i).' };
    }
    if (f==='4.3'){
      const marc       = $$('input[type="checkbox"]:checked', el.f43Lista);
      const plano      = ($('#F43_PLANO')?.value||'').trim();
      const planoB     = ($('#F43_PLANO_B')?.value||'').trim();
      const descPlanos = ($('#F43_DESC_PLANOS')?.value||'').trim();
      const incluir    = $$('#F43_INCLUIR input[type="checkbox"]:checked').length > 0;
      const just       = ($('#F43_JUST')?.value||'').trim();

      const ok = marc.length || plano || planoB || descPlanos || incluir || just;
      if(!ok){
        return { ok:false, motivo:'Na fase 4.3, marque ao menos um critério ou descreva/justifique no(s) campo(s) disponível(is).' };
      }
    }
    if (f==='4.4'){
      const optE = document.getElementById('F442_OPTE');
      if (optE?.checked) {
        const crits = $$('#F44_CRITERIOS input[type="checkbox"]:checked');
        if (!crits.length) {
          return { ok:false, motivo:'Na 4.4, ao marcar a finalidade “e)”, selecione pelo menos um critério em 4.4.3.' };
        }
      }
    }
    if (f==='4.5'){
      const ok451 = $('#blk_45 input[type="checkbox"]:checked');
      const docs = ($('#F45_DOCS')?.value||'').trim();
      const jus  = ($('#F45_JUST')?.value||'').trim();
      const exec = ($('#F453_EXEC_RES')?.value||'').trim();
      if(!ok451 && !docs && !jus && !exec) {
        return { ok:false, motivo:'Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas/execução.' };
      }
    }
    if (f==='4.6'){
      const crits = $$('input[type="checkbox"]:checked', el.f46Crits);
      const nivel = $('#F46_PROGESTAO')?.value || '';
      const porte = $('#F46_PORTE')?.value || '';
      if(!crits.length) return { ok:false, motivo:'Na fase 4.6, selecione ao menos um critério em 4.6.1.' };
      if(!nivel || !porte) return { ok:false, motivo:'Informe nível Pró-Gestão e Porte ISP-RPPS em 4.6.1 (b/c).' };
    }
    return { ok:true };
  }

  function popularListasFaseComBaseNosCritérios(){
    if(!el.grpCrit) return;
    const itens = $$('input[name="CRITERIOS_IRREGULARES[]"]', el.grpCrit).map(inp => ({
      value: inp.value,
      label: inp.nextElementSibling ? inp.nextElementSibling.textContent : inp.value
    }));

    // 4.3.11(a)
    const f43Incl = document.getElementById('F43_INCLUIR');
    if (f43Incl && !f43Incl.children.length){
      f43Incl.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F43_INCLUIR[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    // 4.3 lista
    if (el.f43Lista && !el.f43Lista.children.length){
      el.f43Lista.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F43_LISTA[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    if(el.f44Crits && !el.f44Crits.children.length){
      el.f44Crits.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F44_CRITERIOS[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
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
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F46_CRITERIOS[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }
    if(el.f46Final && !el.f46Final.children.length){
      el.f46Final.innerHTML = el.f44Final.innerHTML;
    }
    // 4.6.2 (f)
    const f462f = document.getElementById('F462F_CRITERIOS');
    if (f462f && !f462f.children.length) {
      f462f.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F462F_CRITERIOS[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }
  }

  /* ========= Validação geral (mínimos) ========= */
  function validarCamposBasicos(){
    const msgs=[];

    // ESFERA (RPPS Municipal ou Estadual/Distrital) — exigida pelo schema
    const esferaOk = !!(el.esfMun?.checked || el.esfEst?.checked);
    if(!esferaOk) msgs.push('Esfera (RPPS Municipal ou Estadual/Distrital)');

    if(!el.uf.value.trim()) msgs.push('UF');
    if(!el.ente.value.trim()) msgs.push('Ente');
    if(digits(el.cnpjEnte.value).length!==14) msgs.push('CNPJ do Ente');
    if(!isEmail(el.emailEnte.value)) msgs.push('E-mail do Ente');

    // >>> ALTERADO: usa getter robusto (1.3 OU 1.3.2) — evita “0” na planilha
    const cnpjUgRobusto = obterCNPJUG();
    if(!el.ug.value.trim() && !el.ugNome?.value?.trim()) msgs.push('Unidade Gestora');
    if(!cnpjUgRobusto) msgs.push('CNPJ da UG');
    const emailUgFinal = (el.emailUg?.value || el.ugEmail?.value || '').trim();
    if(!isEmail(emailUgFinal)) msgs.push('E-mail da UG');

    if(digits(el.cpfRepEnte.value).length!==11) msgs.push('CPF do Rep. do Ente');
    if(!el.nomeRepEnte.value.trim()) msgs.push('Nome do Rep. do Ente');
    if(!el.cargoRepEnte.value.trim()) msgs.push('Cargo do Rep. do Ente');
    if(!isEmail(el.emailRepEnte.value)) msgs.push('E-mail do Rep. do Ente');

    if(digits(el.cpfRepUg.value).length!==11) msgs.push('CPF do Rep. da UG');
    if(!el.nomeRepUg.value.trim()) msgs.push('Nome do Rep. da UG');
    if(!el.cargoRepUg.value.trim()) msgs.push('Cargo do Rep. da UG');
    if(!isEmail(el.emailRepUg.value)) msgs.push('E-mail do Rep. da UG');

    if(msgs.length){
      showAtencao(['Preencha os campos:', ...msgs.map(m=>'• '+m)]);
      return false;
    }
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

    // fase (seleção única)
    const faseCompat = document.querySelector('input[name="FASE_PROGRAMA"]:checked')?.value || '';

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

    const DATA_VENCIMENTO_ULTIMO_CRP = (el.dataUltCrp?.value) || '';
    const TIPO_EMISSAO_ULTIMO_CRP =
      (el.tipoAdm?.checked && 'Administrativa') ||
      (el.tipoJud?.checked && 'Judicial') || '';

    // >>> NOVO: campos UG consolidados (1.3 OU 1.3.2)
    const UG_FINAL       = (el.ug?.value || el.ugNome?.value || '').trim();
    const CNPJ_UG_FINAL  = obterCNPJUG(); // string com 14 dígitos ou null
    const EMAIL_UG_FINAL = (el.emailUg?.value || el.ugEmail?.value || '').trim();

    if (!CNPJ_UG_FINAL) {
      // Defesa extra: nunca deixar ir “0”
      throw new Error('CNPJ_UG inválido/ausente');
    }

    const obj = {
      HAS_TERMO_ENC_GESCON: el.hasGescon?.value === '1',
      N_GESCON: el.spanNGescon?.textContent || '',
      DATA_ENC_VIA_GESCON: el.spanDataEnc?.textContent || '',

      ESFERA,
      UF: el.uf.value.trim(),
      ENTE: el.ente.value.trim(),
      CNPJ_ENTE: digits(el.cnpjEnte.value),
      EMAIL_ENTE: el.emailEnte.value.trim(),

      UG: UG_FINAL,
      CNPJ_UG: CNPJ_UG_FINAL,
      EMAIL_UG: EMAIL_UG_FINAL,

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
      SEI_PROCESSO: (el.introProcSei?.textContent || el.infoProcSei?.textContent || '').trim(),

      DATA_VENCIMENTO_ULTIMO_CRP,
      TIPO_EMISSAO_ULTIMO_CRP,

      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i => i.value),

      ADESAO_SEM_IRREGULARIDADES,
      FIN_3_2_MANUTENCAO_CONFORMIDADE,
      FIN_3_2_DEFICIT_ATUARIAL,
      FIN_3_2_CRITERIOS_ESTRUTURANTES,
      FIN_3_2_OUTRO_CRITERIO_COMPLEXO,

      FASE_PROGRAMA: faseCompat,
      F41_OPCAO: $('input[name="F41_OPCAO"]:checked')?.value || '',
      F42_LISTA: $$(`#F42_LISTA input[type="checkbox"]:checked`).map(i => i.value),
      F43_LISTA: $$(`#F43_LISTA input[type="checkbox"]:checked`).map(i => i.value),
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

      F4310_OPCAO:  document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '',
      F4310_LEGISLACAO: $('#F4310_LEGISLACAO')?.value || '',
      F4310_DOCS:       $('#F4310_DOCS')?.value || '',

      F43_DESC_PLANOS: $('#F43_DESC_PLANOS')?.value || '',

      F441_LEGISLACAO: $('#F441_LEGISLACAO')?.value || '',
      F445_DESC_PLANOS: $('#F445_DESC_PLANOS')?.value || '',
      F446_DOCS:       $('#F446_DOCS')?.value || '',
      F446_EXEC_RES:   $('#F446_EXEC_RES')?.value || '',

      F453_EXEC_RES: $('#F453_EXEC_RES')?.value || '',

      F462F_CRITERIOS: $$('#F462F_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value),
      F466_DOCS:      $('#F466_DOCS')?.value || '',
      F466_EXEC_RES:  $('#F466_EXEC_RES')?.value || '',

      JUSTIFICATIVAS_GERAIS: el.justGerais?.value || '',

      MES: el.mes.value,
      DATA_SOLIC_GERADA: el.dataSol.value,
      HORA_SOLIC_GERADA: el.horaSol.value,
      ANO_SOLIC_GERADA: el.anoSol.value,

      IDEMP_KEY: takeIdemKey() || ''
    };

    // 1) CRITÉRIOS: garantir chave sem colchetes
    if (Array.isArray(obj['CRITERIOS_IRREGULARES[]']) && !Array.isArray(obj.CRITERIOS_IRREGULARES)) {
      obj.CRITERIOS_IRREGULARES = obj['CRITERIOS_IRREGULARES[]'];
    }

    // 2) CNPJ_UG: garantir valor limpo (14 dígitos)
    if (!obj.CNPJ_UG) {
      try {
        const limpo = String(obj.ug_cnpj || obj.CNPJ_UG || '')
          .replace(/\D/g,'')
          .slice(0,14);
        if (limpo.length === 14) obj.CNPJ_UG = limpo;
      } catch(_) {}
    }

    // 3) PORTARIA padronizada (caso não venha do formulário)
    if (!obj.PORTARIA_SRPC) {
      obj.PORTARIA_SRPC = '2.024/2025';
    }

    dbg('[SOLIC-CRP] Payload pronto:', obj);
    return obj;
  }

  /* ========= Fluxo ÚNICO/ROBUSTO de PDF (via backend) ========= */
  async function gerarBaixarPDF(payload){
    const payloadForPdf = {
      ...payload,
      __NA_ALL: true,                 // <- garante fallback "Não informado" no template
      __NA_LABEL: 'Não informado',
      
      HAS_TERMO_ENC_GESCON: payload.HAS_TERMO_ENC_GESCON ? '1' : '',
      DATA: payload.DATA_SOLIC_GERADA || payload.DATA || '',
      // (opcional) Portaria forçada — padronizada
      PORTARIA_SRPC: '2.024/2025'
    };

    // 🔥 Aquece o backend/Puppeteer ANTES de pedir o PDF (evita 502/restart)
    try {
      await fetchJSON('/_api/warmup', {}, { label: 'warmup', timeout: 8000, retries: 1 });
    } catch (_) { /* segue se warmup falhar */ }

    // Garante que o serviço está de pé (proxy → backend)
    await waitForService({ timeoutMs: 60000, pollMs: 1500 });

    // ► Usar apenas API_BASE (via proxy)
    const tryUrls = [
      api('/termo-solic-crp-pdf') // rota do backend via proxy
    ];

    let blob = null;
    let lastErr = null;

    // 📈 Aumenta os rounds de retry (Render pode reiniciar no cold start)
    for (let round = 0; round < 3 && !blob; round++) {
      for (const urlTry of tryUrls) {
        dbg('[PDF] tentando →', urlTry, '(round', round+1, ')');
        try {
          blob = await fetchBinary(
            urlTry,
            {
              method: 'POST',
              headers: withKey({ 'Content-Type': 'application/json; charset=utf-8' }),
              body: JSON.stringify(payloadForPdf)
            },
            // 🕒 Mais fôlego para carregar fontes/template na 1ª vez
            { label: 'termo-solic-crp-pdf', timeout: 90000, retries: 3 }
          );
          dbg('[PDF] OK em →', urlTry);
          break;
        } catch (e) {
          lastErr = e;
          const s = e && e.status;
          const msg = String(e?.message || '').toLowerCase();
          const retriable = (s >= 500) || msg.includes('timeout') || msg.includes('failed') || e.name === 'AbortError';
          dbg('[PDF] falhou em', urlTry, '| status:', s, '| msg:', e && e.message, '| retriable?', retriable);
          if (!retriable) continue;
          await new Promise(r => setTimeout(r, 300 + Math.random()*300));
        }
      }
      if (!blob) {
        await new Promise(r => setTimeout(r, 800 + Math.random()*400));
      }
    }

    if (!blob) throw lastErr || new Error('Falha ao gerar PDF (todas as rotas tentadas)');

    // download do PDF
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

  // ——— SUBMIT ———
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

    let t = setTimeout(()=> bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).show(), 3000);

    try{
      await waitForService({ timeoutMs: 60000, pollMs: 1500 });

      const resp = await fetchJSON(api('/gerar-solic-crp'), {
        method:'POST',
        headers: withKey({'Content-Type':'application/json','X-Idempotency-Key':idem}),
        body: JSON.stringify(payload)
      }, { label:'gerar-solic-crp', timeout:30000, retries:1 });

      clearTimeout(t);
      try{ bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); }catch{}
      clearIdemKey();
      btn.innerHTML = 'Finalizado ✓';
      
      setTimeout(()=>{
        try{ form.reset(); }catch{}
        clearAllState();

        el.hasGescon && (el.hasGescon.value = '0');
        el.cnpjInput && (el.cnpjInput.value = '');
        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.spanNGescon) el.spanNGescon.textContent = '';
        if (el.spanDataEnc) el.spanDataEnc.textContent = '';
        if (el.spanUfGescon) el.spanUfGescon.textContent = '';
        if (el.spanEnteGescon) el.spanEnteGescon.textContent = '';
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';

        // ✅ usa a resposta da API (se houver) para preencher o nº do processo SEI
        const procSei = (resp && (resp.proc_sei || resp.PROC_SEI)) || '';
        if (el.infoProcSei)  el.infoProcSei.textContent  = procSei || '—';
        if (el.introProcSei) el.introProcSei.textContent = procSei || '—';

        if (el.btnNext) el.btnNext.disabled = true;

        btn.disabled=false; btn.innerHTML=old;

        curStep = 0;
        window.__renderStepper?.();

      }, 800);

    }catch(err){
      clearTimeout(t);
      try{ bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); }catch{}
      showErro(friendlyErrorMessages(err, 'Falha ao registrar a solicitação.'));
      btn.disabled=false; btn.innerHTML=old;
    }
  });

  /* ========= UI helpers ========= */
  function showModal(id){ const mEl=document.getElementById(id); if(!mEl) return; bootstrap.Modal.getOrCreateInstance(mEl).show(); }
  function initWelcome(){
    const mw = $('#modalWelcome');
    if(mw){ setTimeout(()=> bootstrap.Modal.getOrCreateInstance(mw).show(), 150); }
  }

  // versão única de showErro
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

  // ---------- [ETAPA 1] preencher cabeçalho "Registros do Termo" ----------
  function preencherRegistrosDoTermo(reg) {
    const $gescon = document.getElementById('reg-gescon-consulta');
    const $data   = document.getElementById('reg-data-encam');
    const $sei    = document.getElementById('reg-proc-sei');

    if ($gescon) $gescon.textContent = reg?.gescon_consulta || '—';
    if ($data)   $data.textContent   = reg?.data_encaminhamento || '—';
    if ($sei)    $sei.textContent    = reg?.processo_sei || '—';
  }

  // chama quando conclui a etapa 0 (após buscar pelo CNPJ)
  async function afterLookupCnpjEtapa0(payload) {
    const reg = payload?.registro_termo || {};
    window.__REGISTRO_TERMO__ = reg;
    preencherRegistrosDoTermo(reg);
    copiar_13_para_132();
  }

  // ---------- [ETAPA 1] copiar 1.3 -> 1.3.2 ----------
  function copiar_13_para_132() {
    // 1.3 (Regime RPPS) – campos fonte
    const ug1_nome = document.querySelector('input[name="rpps_unidade_gestora_nome"]');
    const ug1_cnpj = document.querySelector('input[name="rpps_unidade_gestora_cnpj"]');
    const ug1_mail = document.querySelector('input[name="rpps_unidade_gestora_email"]');

    // 1.3.2 (Unidade Gestora - UG) – campos destino
    const ug2_nome = document.querySelector('input[name="ug_nome"]');
    const ug2_cnpj = document.querySelector('input[name="ug_cnpj"]');
    const ug2_mail = document.querySelector('input[name="ug_email"]');

    if (ug1_nome && ug2_nome && !ug2_nome.value) ug2_nome.value = ug1_nome.value || '';
    if (ug1_cnpj && ug2_cnpj && !ug2_cnpj.value) ug2_cnpj.value = ug1_cnpj.value || '';
    if (ug1_mail && ug2_mail && !ug2_mail.value) ug2_mail.value = ug1_mail.value || '';
  }

  // quando usuário muda a "Situação do RPPS" (RPPS / RPPS em Extinção) continuamos espelhando
  function wireSituacaoEspelhamento() {
    document.querySelectorAll('input[name="situacao_rpps"]').forEach(radio => {
      radio.addEventListener('change', copiar_13_para_132);
    });

    ['rpps_unidade_gestora_nome','rpps_unidade_gestora_cnpj','rpps_unidade_gestora_email']
      .forEach(name => {
        const el = document.querySelector(`input[name="${name}"]`);
        if (el) el.addEventListener('input', copiar_13_para_132);
      });
  }

  // Chame isto no seu init()
  function initEtapa1Bridges() {
    wireSituacaoEspelhamento();
    if (window.__REGISTRO_TERMO__) {
      preencherRegistrosDoTermo(window.__REGISTRO_TERMO__);
    }
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

    $$('.esf-only-one').forEach(chk=>{
      chk.addEventListener('change', ()=>{
        if(chk.checked) $$('.esf-only-one').forEach(o=>{ if(o!==chk) o.checked=false; });
        saveState();
      });
    });

    const form = $('#solicCrpForm');
    form?.addEventListener('input', ()=> setTimeout(saveState, 300));
    form?.addEventListener('change', ()=> setTimeout(saveState, 300));

    if(el.btnNext) el.btnNext.disabled = true;

    ensureStepperFallback();
    window.addEventListener('beforeunload', saveState);

    // >>> novo: liga os bridges da etapa 1 (registro do termo + espelhamento 1.3→1.3.2)
    initEtapa1Bridges();
    // <<<
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
  else{ init(); }

})();
