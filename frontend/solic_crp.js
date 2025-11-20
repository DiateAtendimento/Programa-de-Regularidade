// solic_crp.js — fluxo completo da Solicitação de CRP Emergencial (isolado da Adesão)
(() => {
  // === DEBUG global (ligue/desligue quando quiser) ===
  window.__DEBUG_SOLIC_CRP__ = true;
  function dbg(...args){ if (window.__DEBUG_SOLIC_CRP__) console.log(...args); }
  function dbe(...args){ if (window.__DEBUG_SOLIC_CRP__) console.error(...args); }

  // === Preview helpers (fallback quando o PDF falhar) ===
  const TERMO_SESSION_KEY = 'TERMO_SOLIC_CRP_PAYLOAD';
  function stashPayloadForPreview(p){
    try { sessionStorage.setItem(TERMO_SESSION_KEY, JSON.stringify(p)); } catch(_){}
  }
  function openPreviewWindow(payload){
    try {
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      const url = `termo_solic_crp.html#payload_b64=${b64}`;
      const w = window.open(url, '_blank', 'noopener');
      if (!w) return;
      // envia o payload repetidamente por alguns segundos até o template estar pronto
      const send = ()=>{ try { w.postMessage({ type:'TERMO_PAYLOAD', data: payload }, '*'); } catch(_){ } };
      let tries = 0;
      const t = setInterval(()=>{
        if (w.closed || tries++ > 30) return clearInterval(t);
        send();
      }, 200);
      w.addEventListener?.('load', () => { try { send(); } catch(_){} }, { once:true });
    } catch(e) {
      dbe('[openPreviewWindow] falhou', e);
    }
  }

  /* ========= Config ========= */
  // Preferir o proxy do Netlify SEMPRE (injeta API Key)
  // Em dev local você pode sobrescrever com window.__API_BASE = 'http://localhost:3000/api'
  const API_BASE = (function() {
    const devOverride = (window.__API_BASE && String(window.__API_BASE).replace(/\/+$/, '')) || '';
    const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    // Em produção, nunca usar override para upstream
    return isDev && devOverride ? devOverride : '/_api';
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
        const r = await getJSON(api('/health'));
        if (r && (r.ok || r.status === 'ok')) return true;
      } catch (_) {}
      await new Promise(r => setTimeout(r, pollMs));
    }
    return false;
  }

  // PATCH (A1) — serializer robusto
  function serializeFormToPayload(formEl) {
    const payload = {};
    const push = (k, v) => {
      if (v == null || v === '') return;
      if (!Array.isArray(payload[k])) payload[k] = [];
      payload[k].push(v);
    };
    const readVal = (el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      if (tag === 'select' && el.multiple) {
        return Array.from(el.selectedOptions).map(o => o.value).filter(Boolean);
      }
      if (type === 'checkbox') return el.checked ? (el.value || 'SIM') : null;
      if (type === 'radio')    return el.checked ? (el.value || '') : null;
      return (el.value || '').trim();
    };

    // [name]
    formEl.querySelectorAll('[name]').forEach(el => {
      if (el.disabled) return;
      const name = el.getAttribute('name');
      const val  = readVal(el);
      if (val == null || (Array.isArray(val) && !val.length)) return;

      if (name.endsWith('[]')) {
        const base = name.slice(0, -2);
        if (Array.isArray(val)) val.forEach(v => push(base, v)); else push(base, val);
      } else {
        if (Array.isArray(val)) {
          payload[name] = val;
        } else {
          if (payload[name] === undefined) payload[name] = val;
          else {
            if (!Array.isArray(payload[name])) payload[name] = [payload[name]];
            payload[name].push(val);
          }
        }
      }
    });

    // [data-k] — também apoia preview → payload
    formEl.querySelectorAll('[data-k]').forEach(el => {
      const key = el.getAttribute('data-k');
      if (payload[key] !== undefined) return;
      let val = ['input','select','textarea'].includes(el.tagName.toLowerCase())
        ? readVal(el)
        : (el.textContent || '').trim();
      if (val == null || val === '') return;
      payload[key] = val;
    });

    // espelhar arrays como KEY[]
    Object.keys(payload).forEach(k => {
      if (Array.isArray(payload[k])) payload[`${k}[]`] = payload[k].slice();
    });

    // === AJUSTE ESPECÍFICO PARA F43_INCLUIR / F43_INCLUIR_B ===
    // O backend espera string, não array
    if (Array.isArray(payload.F43_INCLUIR)) {
      payload.F43_INCLUIR = payload.F43_INCLUIR.join('; ');
    }
    if (Array.isArray(payload.F43_INCLUIR_B)) {
      payload.F43_INCLUIR_B = payload.F43_INCLUIR_B.join('; ');
    }

    // espelha a fase também em __FASE_SEL__ (o template usa isso para resolver 4.x)
    if (!payload.__FASE_SEL__) {
      payload.__FASE_SEL__ = payload.FASE_PROGRAMA || '';
    }


    return payload;
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
    const s = String(v).trim();

    // Já no formato BR (dd/mm/aaaa)
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;

    // Número serial (Google Sheets/Excel) — pode vir como number OU string "45927"
    if ((typeof v === 'number' && isFinite(v)) || (/^\d{4,6}$/.test(s))) {
      const n = Number(v);
      const base = new Date(1899, 11, 30); // Sheets base
      const d = new Date(base.getTime() + n * 86400000);
      return d.toLocaleDateString('pt-BR', { timeZone:'America/Sao_Paulo' });
    }

    // ISO (yyyy-mm-dd[...])
    const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (mIso) return `${mIso[3]}/${mIso[2]}/${mIso[1]}`;

    // Campos legados comuns (ex.: "2025/10/21", "21-10-2025")
    const mY = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (mY) return `${mY[3]}/${mY[2]}/${mY[1]}`;
    const mD = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (mD) return `${mD[1]}/${mD[2]}/${mD[3]}`;

    // Último recurso: mantém como veio
    return s;
  }

  // Novo: converte diversos formatos para AAAA-MM-DD (compatível com <input type="date">)
  function toISOForInput(v){
    if (v == null || v === '') return '';
    const s = String(v).trim();
    // já é ISO?
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // dd/mm/aaaa -> aaaa-mm-dd
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m){
      const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0'), y = m[3];
      return `${y}-${mo}-${d}`;
    }
    // número serial (planilha)
    if (/^\d{4,}$/.test(s)) {
      const base = new Date(1899,11,30); // Excel serial base
      const dt = new Date(base.getTime() + (Number(s) * 86400000));
      const y = String(dt.getFullYear());
      const mo = String(dt.getMonth()+1).padStart(2,'0');
      const d = String(dt.getDate()).padStart(2,'0');
      return `${y}-${mo}-${d}`;
    }
    // fallback: tenta Date.parse
    const t = Date.parse(s);
    if (!isNaN(t)){
      const dt = new Date(t);
      const y = String(dt.getFullYear());
      const mo = String(dt.getMonth()+1).padStart(2,'0');
      const d = String(dt.getDate()).padStart(2,'0');
      return `${y}-${mo}-${d}`;
    }
    return '';
  }

  // --- Validação do nº Gescon: S|L + 6 dígitos + "/" + ano
  function isGesconNumber(x){
    return /^[SL]\d{6}\/\d{4}$/i.test(String(x).trim());
  }

  // --- GARANTIAS: fase_programa + datas normalizadas para o payload do PDF/submit
  function ensureDefaultsForPayload(payload){
    if (!payload.FASE_PROGRAMA && !payload.__FASE_SEL__) {
      payload.FASE_PROGRAMA = 'Solicitação de CRP';
    }
    if (!payload.DATA && !payload.DATA_SOLIC_GERADA) {
      const d = new Date();
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      payload.DATA_SOLIC_GERADA = `${dd}/${mm}/${d.getFullYear()}`;
    }
    const toBR = (v)=> {
      if (!v) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
        const [Y,M,D] = String(v).split('-'); return `${D}/${M}/${Y}`;
      }
      return String(v);
    };
    payload.DATA_SOLIC_GERADA = toBR(payload.DATA_SOLIC_GERADA);
    payload.DATA = toBR(payload.DATA);
    // Converte whatever -> DD/MM/AAAA só no payload final (para o template e planilha)
    payload.DATA_VENC_ULTIMO_CRP = toBR(payload.DATA_VENC_ULTIMO_CRP || payload.DATA_VENCIMENTO_ULTIMO_CRP);
    payload.DATA_VENCIMENTO_ULTIMO_CRP = payload.DATA_VENC_ULTIMO_CRP;
  }

  /* ========= Robust fetch (timeout + retries) ========= */
  const FETCH_TIMEOUT_MS = 120000;
  const FETCH_RETRIES    = 1;

  async function postJSON(url, body, extraHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders
    };
    // Se você usa API key, defina window.__API_KEY__ em produção
    if (window.__API_KEY__) headers['X-API-Key'] = window.__API_KEY__;

    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers,
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[solic_crp] POST FAIL', url, resp.status, txt);
      // Propaga motivo legível para a UI
      throw new Error(`HTTP ${resp.status} — ${txt.slice(0, 500)}`);
    }

    // pode não haver JSON
    try { return await resp.json(); } catch { return {}; }
  }

  // === GET padronizado com erro detalhado ===
  async function getJSON(url, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (window.__API_KEY__) headers['X-API-Key'] = window.__API_KEY__;
    const resp = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', headers });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      console.error('[solic_crp] GET FAIL', url, resp.status, txt);
      throw new Error(`HTTP ${resp.status} — ${txt.slice(0,500)}`);
    }
    try { return await resp.json(); } catch { return {}; }
  }

  // === Compat: fetchJSON usado pelo resto do código (GET/POST) ===
  async function fetchJSON(url, opts = {}, meta = {}) {
    const method  = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const body    = opts.body;

    if (method === 'GET') {
      return await getJSON(url, headers);
    }
    // POST/PUT/PATCH com JSON
    const resp = await fetch(url, {
      method,
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...headers },
      body
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      console.error('[solic_crp]', method, 'FAIL', url, resp.status, txt);
      throw new Error(`HTTP ${resp.status} — ${txt.slice(0,500)}`);
    }
    try { return await resp.json(); } catch { return {}; }
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
    // campos espelho 1.3.x
    ugNome:  $('#ug_nome'),
    ugCnpj:  $('#ug_cnpj'),
    ugEmail: $('#ug_email'),
    ugOrgaoVinc: $('#ug_orgao_vinc'), // 1.3.4 Órgão de vinculação da UG
    esfMun: $('#esf_mun'), esfEst: $('#esf_est'),
    infoNumGescon: $('#infoNumGescon'),

    // etapa 2
    cpfRepEnte: $('#CPF_REP_ENTE'), nomeRepEnte: $('#NOME_REP_ENTE'),
    cargoRepEnte: $('#CARGO_REP_ENTE'), emailRepEnte: $('#EMAIL_REP_ENTE'), telRepEnte: $('#TEL_REP_ENTE'),
    cpfRepUg: $('#CPF_REP_UG'), nomeRepUg: $('#NOME_REP_UG'),
    cargoRepUg: $('#CARGO_REP_UG'), emailRepUg: $('#EMAIL_REP_UG'), telRepUg: $('#TEL_REP_UG'),

    // etapa 3 (critérios)
    grpCrit: $('#grpCRITERIOS'),

    // ===== Campos 3.1 / 3.2 (compat: aceita o novo e o legado) =====
    dataUltCrp: document.getElementById('DATA_VENC_ULTIMO_CRP') || document.getElementById('dataUltCrp'),
    selectTipoUltCrp: document.getElementById('TIPO_EMISSAO_ULTIMO_CRP'),
    // Mantém fallback para rádios antigos caso existam em algum layout
    tipoAdm: document.getElementById('tipoAdm'),
    tipoJud: document.getElementById('tipoJud'),

    // etapa 4
    faseRadios: $$('input[name="FASE_PROGRAMA"]'),
    blk41: $('#blk_41'), blk42: $('#blk_42'), blk43: $('#blk_43'),
    blk44: $('#blk_44'), blk45: $('#blk_45'), blk46: $('#blk_46'),
    f42Lista: $('#F42_LISTA'), f43Lista: $('#F43_LISTA'),
    f44Crits: $('#F44_CRITERIOS'), f44Final: $('#F44_FINALIDADES'),
    f46Crits: $('#F46_CRITERIOS') || $('#F462F_CRITERIOS'), f46Final: $('#F46_FINALIDADES'),

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
      'ug_nome','ug_cnpj','ug_email', 'ug_orgao_vinc',
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

    const _inclArr   = collectCheckedValues('#F43_INCLUIR input[type="checkbox"]');
    const _inclArr_B = collectCheckedValues('#F43_INCLUIR_B input[type="checkbox"]');

    // versão em string para reaproveitar no payload/preview
    data.values['F43_INCLUIR']   = _inclArr.length   ? _inclArr.join('; ')   : '';
    data.values['F43_INCLUIR_B'] = _inclArr_B.length ? _inclArr_B.join('; ') : '';


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

    // 4.6 — usar o contêiner F46_CRITERIOS se existir; senão, cair para F462F_CRITERIOS (que é o que o HTML tem)
    const _critF46 = $$('#F46_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value);
    const _critAlt = $$('#F462F_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value);
    data.values['F46_CRITERIOS[]']   = _critF46.length ? _critF46 : _critAlt;

    data.values['F46_PROGESTAO']     = $('#F46_PROGESTAO')?.value || '';
    data.values['F46_PORTE']         = $('#F46_PORTE')?.value || '';
    data.values['F46_JUST_D']        = $('#F46_JUST_D')?.value || '';
    data.values['F46_DOCS_D']        = $('#F46_DOCS_D')?.value || '';
    data.values['F46_JUST_E']        = $('#F46_JUST_E')?.value || '';
    data.values['F46_DOCS_E']        = $('#F46_DOCS_E')?.value || '';

    // finalidades já existem com esse ID
    data.values['F46_FINALIDADES[]'] = $$(`#F46_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value);

    // ANEXOS / JUSTIFICATIVAS / COMPROVAÇÃO — cair para os campos que o HTML realmente usa (F466_DOCS/F466_EXEC_RES, F46_JUST_D/E)
    data.values['F46_ANEXOS']        = $('#F46_ANEXOS')?.value || $('#F466_DOCS')?.value || '';
    data.values['F46_JUST_PLANOS']   = $('#F46_JUST_PLANOS')?.value || $('#F46_JUST_D')?.value || $('#F46_JUST_E')?.value || '';
    data.values['F46_COMP_CUMPR']    = $('#F46_COMP_CUMPR')?.value || $('#F466_EXEC_RES')?.value || '';

    data.values['F462F_OPTF']        = !!$('#F462F_OPTF')?.checked;
    data.values['F462F_CRITERIOS[]'] = $$('#F462F_CRITERIOS input[type="checkbox"]:checked').map(i=>i.value);
    data.values['F466_DOCS']         = $('#F466_DOCS')?.value || '';
    data.values['F466_EXEC_RES']     = $('#F466_EXEC_RES')?.value || '';

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

  $('#modalAtencao')?.addEventListener('shown.bs.modal', () =>
    mountLottie('lottieAtencao', 'animacao/atencao-info.json', { loop:false, autoplay:true })
  );

  $('#modalErro')?.addEventListener('shown.bs.modal', () =>
    mountLottie('lottieError', 'animacao/confirm-error.json', { loop:false, autoplay:true })
  );

  /* ========= Botão "Voltar" que fecha os modais da Fase 4 ========= */
  function ensureBackButton(modalId){
    const el = document.getElementById(modalId);
    if (!el) return;

    const content = el.querySelector('.modal-content');
    if (!content) return;

    // garante <div class="modal-footer">
    let footer = content.querySelector('.modal-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'modal-footer';
      content.appendChild(footer);
    }

    // evita duplicar
    if (footer.querySelector('[data-action="voltar-fecha"]')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline-secondary ms-auto';
    btn.textContent = 'Voltar';
    btn.setAttribute('data-action', 'voltar-fecha');
    btn.setAttribute('data-bs-dismiss', 'modal'); // Bootstrap fecha o modal

    footer.appendChild(btn);
  }

  // fallback caso o Bootstrap não esteja disponível por algum motivo
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="voltar-fecha"]');
    if (!btn) return;
    const modalEl = btn.closest('.modal');
    if (!modalEl) return;
    try {
      const m = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
      m.hide();
    } catch {}
  });

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
        dbg('Sem registro válido Gescon → BLOQUEIA fluxo e exibe orientação…');
        el.hasGescon && (el.hasGescon.value = '0');
        if (el.btnNext) el.btnNext.disabled = true; // ← não deixa avançar

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

        // pode hidratar a tela, mas sem avançar passo
        try { await hidratarTermosRegistrados(cnpj); } catch (e) { dbe('hidratarTermosRegistrados falhou:', e); }

        // mostra o modal com a mensagem exigida
        showModal('modalGesconNaoEncontrado');

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
      {
        const infoNum = document.getElementById('infoNumGescon');
        if (infoNum) infoNum.textContent = nGescon || '—';
      }

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
        dbg('CNPJ não localizado no Gescon → BLOQUEIA fluxo e exibe orientação…');
        el.hasGescon && (el.hasGescon.value = '0');
        if (el.btnNext) el.btnNext.disabled = true; // ← bloqueado

        el.boxGescon && el.boxGescon.classList.add('d-none');
        if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = '—';
        const infoNum = document.getElementById('infoNumGescon'); if (infoNum) infoNum.textContent = '—';

        try { await hidratarTermosRegistrados(cnpj); } catch (e) {}

        // abre o modal com a mensagem pedida e não avança
        showModal('modalGesconNaoEncontrado');

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

      // Órgão de Vinculação (1. Identificação) – vindo do Termos_registrados
      const orgField = document.getElementById('ug_orgao_vinc');
      if (orgField && data?.ente?.orgao_vinculacao_ug) {
        orgField.value = data.ente.orgao_vinculacao_ug;
      }

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

      // 3) CRP anterior — preencher 3.1 (data) e 3.2 (tipo)
      // depois (mais robusto)
      const dataVenc =
        crp.data_venc
        || crp.DATA_VALIDADE_DMY
        || crp.DATA_VALIDADE_ISO
        || crp.DATA_VALIDADE
        || crp.data_validade
        || crp.validade
        || crp.vencimento
        || '';

      // Preencher <input type="date"> SEMPRE em ISO (AAAA-MM-DD)
      if (el.dataUltCrp) el.dataUltCrp.value = toISOForInput(dataVenc);

      // ===== NOVO BLOCO (sincronizar CRP com __TERMO_DATA__ para o template) =====
      try {
        // helpers locais
        const toBR = (v) => {
          if (!v) return '';
          const s = String(v).trim();
          const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
          return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
        };
        const normTipo = (t) => {
          const s = String(t || '').trim().toLowerCase();
          if (!s) return '';
          if (s.startsWith('adm')) return 'Administrativa';
          if (s.startsWith('jud')) return 'Judicial';
          if (s === 's' || s === 'sim' || s === 'true' || s === '1') return 'Judicial';
          if (s === 'n' || s === 'nao' || s === 'não' || s === 'false' || s === '0') return 'Administrativa';
          return t;
        };
        const setIfVal = (obj, k, v) => { if (v !== '' && v != null) obj[k] = v; };

        // base de dados da página
        window.__TERMO_DATA__ = window.__TERMO_DATA__ || {};

        // 1) Captura dos campos na tela (já em ISO no input type="date")
        const dataVencISO =
          (el?.dataUltCrp && String(el.dataUltCrp.value || '').trim()) || '';
        const dataVencBR  = toBR(dataVencISO);

        let tipoFormat =
          (el?.selectTipoUltCrp && String(el.selectTipoUltCrp.value || '').trim()) ||
          (el?.tipoAdm && el.tipoAdm.checked ? 'Administrativa'
            : (el?.tipoJud && el.tipoJud.checked ? 'Judicial' : ''));

        tipoFormat = normTipo(tipoFormat);

        // 2) Data do termo (carimbo do formulário ou hoje)
        const todayBR = (() => {
          try { return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
          catch { return ''; }
        })();

        const dataTermo =
          (document.getElementById('DATA_SOLIC_GERADA')?.value || '').trim() ||
          (el?.dataSol && String(el.dataSol.value || '').trim()) ||
          todayBR;

        // 3) Gravação segura dos aliases (só se houver valor)
        const TD = window.__TERMO_DATA__;
        // Datas do último CRP (preferência BR para o template)
        setIfVal(TD, 'DATA_VENC_ULTIMO_CRP',          dataVencBR);
        setIfVal(TD, 'DATA_VENCIMENTO_ULTIMO_CRP',    dataVencBR);
        setIfVal(TD, 'venc_ult_crp',                  dataVencBR);
        setIfVal(TD, 'ULTIMO_CRP_DATA',               dataVencBR);

        // (opcional) manter uma cópia ISO se algum template/JS quiser
        setIfVal(TD, 'DATA_VENC_ULTIMO_CRP_ISO',      dataVencISO);

        // Tipo do último CRP
        setIfVal(TD, 'TIPO_EMISSAO_ULTIMO_CRP',       tipoFormat);
        setIfVal(TD, 'tipo_emissao_ult_crp',          tipoFormat);
        setIfVal(TD, 'ULTIMO_CRP_TIPO',               tipoFormat);

        // Data do termo (usada em alguns templates com data-k="data_termo")
        setIfVal(TD, 'data_termo',                    dataTermo);

        // 4) Notifica o template para re-render (data-k / fallbacks)
        document.dispatchEvent(new Event('TERMO_DATA'));

      } catch (e) {
        console.warn('Falha ao espelhar __TERMO_DATA__ após hidratarTermosRegistrados:', e);
      }


      // Regra “não ⇒ Administrativa / sim ⇒ Judicial”
      let tipo = '';
      const flag = (crp.DECISAO_JUDICIAL || crp.e_judicial || crp.tipo_simnao || '').toString().trim().toLowerCase();
      if (['sim','s','true','1','yes','y'].includes(flag))      tipo = 'Judicial';
      else if (['nao','não','n','false','0','no'].includes(flag)) tipo = 'Administrativa';
      // fallback: usa crp.tipo se já vier normalizado
      if (!tipo && crp.tipo) tipo = crp.tipo;

      // Preenche select novo, ou rádios legados
      if (el.selectTipoUltCrp) {
        el.selectTipoUltCrp.value = tipo || '';
      } else {
        if (el.tipoAdm) el.tipoAdm.checked = (tipo === 'Administrativa');
        if (el.tipoJud) el.tipoJud.checked = (tipo === 'Judicial');
      }

      // PATCH E — passo 1: logs após hidratar 3.1 / 3.2
      if (window.__DEBUG_SOLIC_CRP__) {
        try {
          const _venc =
            (el.infoDataVencUltimoCrp?.textContent ?? '').trim() ||
            (el.dataUltCrp?.value ?? '').trim() || null;

          const _tipo =
            (el.infoTipoEmissaoUltimoCrp?.textContent ?? '').trim() ||
            (el.selectTipoUltCrp?.value ?? '').trim() ||
            ((el.tipoAdm?.checked ? 'Administrativa' : (el.tipoJud?.checked ? 'Judicial' : '')) || '').trim() ||
            null;

          console.log('[E1] hidratarTermosRegistrados → CRP', {
            '3.1_DATA_VENC_ULTIMO_CRP': _venc,
            '3.2_TIPO_EMISSAO_ULTIMO_CRP': _tipo
          });
        } catch {}
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
      const procSeiUpper = data?.proc_sei ?? data?.PROCESSO_SEI ?? '';
      if (procSeiUpper && el.infoProcSei) el.infoProcSei.textContent = procSeiUpper;
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

  // Disponibiliza no escopo global para diagnósticos/testes
  window.hidratarTermosRegistrados = hidratarTermosRegistrados;
  window.el = el;
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

    // (UX) garante que todos os modais da Fase 4 tenham o botão "Voltar"
    ['modalF41','modalF42','modalF43','modalF44','modalF45','modalF46']
      .forEach(id => ensureBackButton(id));
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

  // === UI dinâmica para 4.6 (cria inputs se não existirem e sincroniza com o template) ===
  function ensureF46UI(){
    const modal = document.getElementById('modalF46');
    const host  = document.querySelector('#blk_46 .modal-body') || modal?.querySelector('.modal-body') || modal;
    if (!host) return;

    // Cria um wrapper uma única vez
    let wrap = host.querySelector('[data-f46-ui]');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.setAttribute('data-f46-ui', '1');
      wrap.className = 'mt-3';
      wrap.innerHTML = `
        <div class="mb-3">
          <label class="form-label fw-semibold">4.6.1 (b) Nível de certificação no Pró-Gestão RPPS</label>
          <select id="F46_PROGESTAO" class="form-select">
            <option value="">Selecione…</option>
            <option value="Nível II">Nível II</option>
            <option value="Nível III">Nível III</option>
            <option value="Nível IV">Nível IV</option>
          </select>
          <div class="form-text">Requisitos mínimos: Nível II (Porte Pequeno – ISP-RPPS); Nível III (Porte Médio/Grande); Nível IV (Porte Especial).</div>
        </div>

        <div class="mb-3">
          <label class="form-label fw-semibold">4.6.1 (c) Grupo de Porte (ISP-RPPS)</label>
          <select id="F46_PORTE" class="form-select">
            <option value="">Selecione…</option>
            <option value="Porte Pequeno">Porte Pequeno (ISP-RPPS)</option>
            <option value="Porte Médio">Porte Médio (ISP-RPPS)</option>
            <option value="Porte Grande">Porte Grande (ISP-RPPS)</option>
            <option value="Porte Especial">Porte Especial (ISP-RPPS)</option>
          </select>
        </div>

        <hr class="my-3">

        <div class="mb-2 fw-semibold">4.6.1 (d) Houve melhora na situação financeira e atuarial do RPPS (anexar comprovações)</div>
        <div class="mb-2">
          <label for="F46_JUST_D" class="form-label">Justificativas (item d)</label>
          <textarea id="F46_JUST_D" class="form-control" rows="3" placeholder="Descreva as evidências de melhora (ex.: ISP-RPPS, fluxo, etc.)"></textarea>
        </div>
        <div class="mb-3">
          <label for="F46_DOCS_D" class="form-label">Documentos (item d)</label>
          <textarea id="F46_DOCS_D" class="form-control" rows="2" placeholder="Liste os documentos/links ou referência dos anexos"></textarea>
        </div>

        <div class="mb-2 fw-semibold">4.6.1 (e) Medidas de acompanhamento atuarial (arts. 67 a 69 da Portaria MTP nº 1.467/2022)</div>
        <div class="mb-2">
          <label for="F46_JUST_E" class="form-label">Justificativas (item e)</label>
          <textarea id="F46_JUST_E" class="form-control" rows="3" placeholder="Descreva as medidas e o acompanhamento realizado"></textarea>
        </div>
        <div class="mb-3">
          <label for="F46_DOCS_E" class="form-label">Documentos (item e)</label>
          <textarea id="F46_DOCS_E" class="form-control" rows="2" placeholder="Liste os documentos/links ou referência dos anexos"></textarea>
        </div>
      `;
      host.appendChild(wrap);
    }

    // (a) já é coberto pela sua função popularListasFaseComBaseNosCritérios(): #F46_CRITERIOS

    // Bind de sincronização: qualquer mudança reflete no preview e salva estado
    const ids = ['F46_PROGESTAO','F46_PORTE','F46_JUST_D','F46_DOCS_D','F46_JUST_E','F46_DOCS_E'];
    ids.forEach(id => {
      const node = document.getElementById(id);
      if (!node) return;
      if (!node.__f46Bound) {
        node.__f46Bound = true;
        node.addEventListener('input', syncF46ToTemplate);
        node.addEventListener('change', syncF46ToTemplate);
      }
    });

    // Também refletir checkboxes dos critérios (a) imediatamente
    ['#F46_CRITERIOS input[type="checkbox"]',
    '#F462F_CRITERIOS input[type="checkbox"]',
    '#F46_FINALIDADES input[type="checkbox"]']
    .forEach(sel => {
      document.querySelectorAll(sel).forEach(chk=>{
        if (!chk.__f46Bound) {
          chk.__f46Bound = true;
          chk.addEventListener('change', ()=>{ syncF46ToTemplate(); saveState(); });
        }
      });
    });

    // Restaurar valores salvos (se houver)
    const st = (function(){ try { return JSON.parse(localStorage.getItem('solic-crp-form-v1')||'{}'); } catch(_) { return {}; } })();
    const v = st.values || {};
    if (v.F46_PROGESTAO) document.getElementById('F46_PROGESTAO').value = v.F46_PROGESTAO;
    if (v.F46_PORTE)     document.getElementById('F46_PORTE').value     = v.F46_PORTE;
    if (v.F46_JUST_D)    document.getElementById('F46_JUST_D').value    = v.F46_JUST_D;
    if (v.F46_DOCS_D)    document.getElementById('F46_DOCS_D').value    = v.F46_DOCS_D;
    if (v.F46_JUST_E)    document.getElementById('F46_JUST_E').value    = v.F46_JUST_E;
    if (v.F46_DOCS_E)    document.getElementById('F46_DOCS_E').value    = v.F46_DOCS_E;

    // Primeira sincronização para garantir exibição
    syncF46ToTemplate();
  }

function syncF46ToTemplate(){
  try{
    window.__TERMO_DATA__ = window.__TERMO_DATA__ || {};

    const pickChecked = (sel) => Array.from(document.querySelectorAll(sel))
      .filter(i=>i.checked)
      .map(i=>i.value);

    __TERMO_DATA__.F46_CRITERIOS   = pickChecked('#F46_CRITERIOS input[type="checkbox"]');
    __TERMO_DATA__.F462F_CRITERIOS = pickChecked('#F462F_CRITERIOS input[type="checkbox"]');
    __TERMO_DATA__.F46_FINALIDADES = pickChecked('#F46_FINALIDADES input[type="checkbox"]');

    __TERMO_DATA__.F46_PROGESTAO = document.getElementById('F46_PROGESTAO')?.value || '';
    __TERMO_DATA__.F46_PORTE     = document.getElementById('F46_PORTE')?.value     || '';
    __TERMO_DATA__.F46_JUST_D    = document.getElementById('F46_JUST_D')?.value    || '';
    __TERMO_DATA__.F46_DOCS_D    = document.getElementById('F46_DOCS_D')?.value    || '';
    __TERMO_DATA__.F46_JUST_E    = document.getElementById('F46_JUST_E')?.value    || '';
    __TERMO_DATA__.F46_DOCS_E    = document.getElementById('F46_DOCS_E')?.value    || '';

    document.dispatchEvent(new Event('TERMO_DATA'));
    saveState();
  }catch(e){ console.warn('syncF46ToTemplate fail', e); }
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
      // NÃO use "p" aqui — leia do DOM
      const critF46   = $$('#F46_CRITERIOS input[type="checkbox"]:checked').length;
      const critF46_2 = $$('#F462F_CRITERIOS input[type="checkbox"]:checked').length;
      const temCrit   = (critF46 + critF46_2) > 0;

      const nivel = ($('#F46_PROGESTAO')?.value || '').trim();
      const porte = ($('#F46_PORTE')?.value     || '').trim();

      if(!temCrit) return { ok:false, motivo:'Na fase 4.6, selecione ao menos um critério em 4.6.1.' };
      if(!nivel || !porte) return { ok:false, motivo:'Informe nível Pró-Gestão e Porte ISP-RPPS em 4.6.1 (b/c).' };
    }

    return { ok:true };
  }


  // PATCH (A2) — reflete seleções da Fase 4 no __TERMO_DATA__
  function popularListasFaseComBaseNosCritérios(){
    if(!el.grpCrit) return;

    const itens = $$('input[name="CRITERIOS_IRREGULARES[]"]', el.grpCrit).map(inp => ({
      value: inp.value,
      label: inp.nextElementSibling ? inp.nextElementSibling.textContent : inp.value
    }));

    const inject = (containerSel, name) => {
      const cont = document.querySelector(containerSel);
      if (cont && !cont.children.length) {
        cont.innerHTML = itens.map(it => (
          `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="${name}" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
        )).join('');
      }
    };

    inject('#F43_LISTA', 'F43_LISTA[]');
    inject('#F44_CRITERIOS', 'F44_CRITERIOS[]');
    inject('#F46_CRITERIOS', 'F46_CRITERIOS[]');
    inject('#F462F_CRITERIOS', 'F462F_CRITERIOS[]');
    inject('#F46_DECLS', 'F46_DECLS[]');
    inject('#F43_INCLUIR_B', 'F43_INCLUIR_B[]');

    if (el.f43Lista && !document.querySelector('#F43_INCLUIR input')) {
      const f43Incl = document.getElementById('F43_INCLUIR');
      if (f43Incl) {
        f43Incl.innerHTML = itens.map(it => (
          `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F43_INCLUIR[]" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
        )).join('');
      }
    }

    if (el.f44Final && !document.querySelector('#F44_FINALIDADES input')) {
      const finals = [
        'Implementação do plano de equacionamento do déficit atuarial',
        'Prazos adicionais para comprovação de medidas',
        'Plano de equacionamento alternativo (art. 55, § 7º, Portaria 1.467/2022)',
        'Adequação da Unidade Gestora Única (CF, art. 40, § 20)',
        'Organização do RPPS / cumprimento de critério estruturante (especificar)'
      ];
      el.f44Final.innerHTML = finals.map(txt => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" name="F44_FINALIDADES[]" value="${txt}"><span class="form-check-label">${txt}</span></label>`
      )).join('');
    }

    if (el.f46Final && !document.querySelector('#F46_FINALIDADES input')) {
      el.f46Final.innerHTML = document.getElementById('F44_FINALIDADES')?.innerHTML || '';
    }

    // >>> refletir no template (data-k) e no payload via __TERMO_DATA__
    try {
      window.__TERMO_DATA__ = window.__TERMO_DATA__ || {};
      const pick = sel => Array.from(document.querySelectorAll(sel)).filter(i=>i.checked).map(i=>i.value);

      window.__TERMO_DATA__.F42_LISTA       = pick('#F42_LISTA input[type="checkbox"]');
      window.__TERMO_DATA__.F43_LISTA       = pick('#F43_LISTA input[type="checkbox"]');
      window.__TERMO_DATA__.F43_INCLUIR     = pick('#F43_INCLUIR input[type="checkbox"]');
      window.__TERMO_DATA__.F44_CRITERIOS   = pick('#F44_CRITERIOS input[type="checkbox"]');
      window.__TERMO_DATA__.F44_DECLS       = pick('#blk_44 .d-flex input[type="checkbox"]');
      window.__TERMO_DATA__.F44_FINALIDADES = pick('#F44_FINALIDADES input[type="checkbox"]');
      window.__TERMO_DATA__.F46_CRITERIOS   = pick('#F46_CRITERIOS input[type="checkbox"]');
      window.__TERMO_DATA__.F46_FINALIDADES = pick('#F46_FINALIDADES input[type="checkbox"]');
      window.__TERMO_DATA__.F462F_CRITERIOS = pick('#F462F_CRITERIOS input[type="checkbox"]');

      document.dispatchEvent(new Event('TERMO_DATA'));
    } catch (e) {
      console.warn('popularListasFaseComBaseNosCritérios sync fail:', e);
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

  // --- ADICIONAR: helpers para coletar valores dos modais -------------------
  function collectCheckedValues(selector) {
    // retorna array de valores (strings) dos checkbox/radio marcados dentro do seletor
    return Array.from(document.querySelectorAll(selector || ''))
      .filter(i => i && i.checked)
      .map(i => String(i.value || '').trim())
      .filter(Boolean);
  }

  function collectTextValue(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  /* ========= Payload ========= */
  function buildPayload(){
    // === Coletas base ===
    const ESFERA =
      (el.esfMun?.checked ? 'RPPS Municipal' :
      (el.esfEst?.checked ? 'Estadual/Distrital' : ''));

    

    // Fase (compat: rádio ou select)
    const FASE_PROGRAMA =
      document.querySelector('input[name="FASE_PROGRAMA"]:checked')?.value
      || document.getElementById('FASE_PROGRAMA')?.value
      || '';

    const ADESAO_SEM_IRREGULARIDADES =
      $('#chkSemIrregularidades')?.checked ? 'SIM' : '';

    let FIN_3_2_MANUTENCAO_CONFORMIDADE =
      document.querySelector('input[name="MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS"]')?.checked ? 'SIM' : '';
    let FIN_3_2_DEFICIT_ATUARIAL =
      document.querySelector('input[name="DEFICIT_ATUARIAL"]')?.checked ? 'SIM' : '';
    let FIN_3_2_CRITERIOS_ESTRUTURANTES =
      document.querySelector('input[name="CRITERIOS_ESTRUT_ESTABELECIDOS"]')?.checked ? 'SIM' : '';
    let FIN_3_2_OUTRO_CRITERIO_COMPLEXO =
      document.querySelector('input[name="OUTRO_CRITERIO_COMPLEXO"]')?.checked ? 'SIM' : '';

    // 3.1 / 3.2 (coleta “crua” do form) + fallbacks fortes
    const DATA_VENCIMENTO_ULTIMO_CRP = (()=>{
      const v =
        (el.dataUltCrp && el.dataUltCrp.value && el.dataUltCrp.value.trim()) ||
        document.getElementById('DATA_VENC_ULTIMO_CRP')?.value?.trim() ||
        document.getElementById('data_venc_ult_crp')?.value?.trim() ||
        document.querySelector('[name="DATA_VENC_ULTIMO_CRP"]')?.value?.trim() ||
        document.querySelector('[name="DATA_VENCIMENTO_ULTIMO_CRP"]')?.value?.trim() ||
        (window.__TERMO_DATA__?.DATA_VENC_ULTIMO_CRP) ||
        (window.__TERMO_DATA__?.venc_ult_crp) || '';
      return v;
    })();

    let TIPO_EMISSAO_ULTIMO_CRP = (()=>{
      const v =
        (el.selectTipoUltCrp && el.selectTipoUltCrp.value && el.selectTipoUltCrp.value.trim()) ||
        (el.tipoAdm?.checked ? 'Administrativa' : (el.tipoJud?.checked ? 'Judicial' : '')) ||
        document.getElementById('TIPO_EMISSAO_ULTIMO_CRP')?.value?.trim() ||
        document.querySelector('[name="TIPO_EMISSAO_ULTIMO_CRP"]')?.value?.trim() ||
        (window.__TERMO_DATA__?.TIPO_EMISSAO_ULTIMO_CRP) ||
        (window.__TERMO_DATA__?.tipo_emissao_ult_crp) || '';
      return v;
    })();

    // 4.1 opção
    const F41_OPCAO = (
      document.querySelector('input[name="F41_OPCAO"]:checked')?.value ||
      document.querySelector('input[name="F41_OPCAO_4_1"]:checked')?.value || ''
    ).trim();

    // 4.1 — código normalizado (envia somente "4.1.1" ou "4.1.2" se houver)
    const F41_OPCAO_CODE = (()=>{
      const m = (F41_OPCAO || '').match(/4\.1\.[12]/);
      return m ? m[0]
              : (document.querySelector('input[name="F41_OPCAO"]:checked')?.value || '').trim();
    })();

    // 4.2, 4.3, 4.4... (listas vindas dos modais)
    const F42_LISTA = Array.from(
      document.querySelectorAll(
        '#F42_LISTA input[type="checkbox"]:checked,' +
        'input[name="F42_LISTA[]"]:checked,' +
        'input[name="F42_ITENS[]"]:checked,' +
        'input[name="fase4_2_criterios[]"]:checked'
      )
    ).map(i => i.value.trim());

    const F44_CRITERIOS = Array.from(new Set([
      collectCheckedValues('#F44_CRITERIOS input[type="checkbox"]'),
      Array.from(document.querySelectorAll('input[name="F44_CRITERIOS[]"]:checked')).map(i => i.value.trim())
    ].flat().filter(Boolean)));

    const F44_DECLS = Array.from(new Set([
      collectCheckedValues('#blk_44 .d-flex input[type="checkbox"]'),
      Array.from(document.querySelectorAll('input[name="F44_DECLS[]"]:checked')).map(i => i.value.trim())
    ].flat().filter(Boolean)));

    const F44_FINALIDADES = Array.from(new Set([
      collectCheckedValues('#F44_FINALIDADES input[type="checkbox"]'),
      Array.from(document.querySelectorAll('input[name="F44_FINALIDADES[]"]:checked')).map(i => i.value.trim())
    ].flat().filter(Boolean)));

    // UG consolidados (1.3 OU 1.3.2)
    const UG_FINAL       = (el.ug?.value || el.ugNome?.value || '').trim();
    let CNPJ_UG_FINAL    = obterCNPJUG(); // retorna 14 dígitos ou null
    if(!CNPJ_UG_FINAL) {
      const rawCnpj = (document.getElementById('CNPJ_UG')?.value || document.getElementById('ug_cnpj')?.value || '');
      const digitsOnly = String(rawCnpj).replace(/\D+/g,'');
      CNPJ_UG_FINAL = (digitsOnly.length === 14) ? digitsOnly : null;
    }
    const EMAIL_UG_FINAL = (el.emailUg?.value || el.ugEmail?.value || '').trim();
    if (!CNPJ_UG_FINAL) { console.warn('[solic_crp] CNPJ_UG ausente — salvando como rascunho'); window.__CNPJ_UG_WARNING__ = true; }

    // === 3.4 — PRAZO ADICIONAL (garante ordem correta das consts) ===
    const _radioPrazo =
      document.querySelector('input[name="prazo_adicional"]:checked') ||
      document.querySelector('input[name="PRAZO_ADICIONAL_3_4"]:checked') ||
      document.querySelector('input[name^="PRAZO_ADICIONAL"]:checked') ||
      document.querySelector('input[name^="OPT_3_4"]:checked') ||
      document.querySelector('input[name*="3_4"]:checked') ||
      document.querySelector('input[data-prz]:checked');

    // --- reforço da extração do código 3.4.x (substitui a captura original de PRAZO_ADICIONAL_COD)
    let PRAZO_ADICIONAL_COD = '';
    if (_radioPrazo) {
      let raw = String(_radioPrazo.value || _radioPrazo.dataset?.prz || '').trim();
      const m = raw.match(/(3\.[24]\.\d)/);
      if (m) raw = m[1];
      PRAZO_ADICIONAL_COD = raw.replace(/^3\.2\.(\d)$/, '3.4.$1'); // normaliza legacy 3.2.x
    }

    // texto: usa um input/textarea opcional OU mapeamento padrão
    const _txtNode  = document.getElementById('przTexto') || document.querySelector('[name="prazo_adicional_texto"]');
    const _txtLivre = String(_txtNode?.value || _txtNode?.textContent || '').trim();

    const _mapPrazo = {
      '3.4.1': '3.4.1 Manutenção da conformidade',
      '3.4.2': '3.4.2 Equacionamento do déficit atuarial (ou necessidade de prazo adicional para implementar)',
      '3.4.3': '3.4.3 Organização do RPPS conforme critérios estruturantes (inclui art. 40, § 20, CF)',
      '3.4.4': '3.4.4 Outro critério que apresente (ou possa apresentar) maior complexidade'
    };
    const PRAZO_ADICIONAL_TEXTO = _txtLivre || _mapPrazo[PRAZO_ADICIONAL_COD] || '';

    // Reflete flags legadas 3.2.x conforme a seleção 3.4.x
    if (PRAZO_ADICIONAL_COD) {
      FIN_3_2_MANUTENCAO_CONFORMIDADE = '';
      FIN_3_2_DEFICIT_ATUARIAL = '';
      FIN_3_2_CRITERIOS_ESTRUTURANTES = '';
      FIN_3_2_OUTRO_CRITERIO_COMPLEXO = '';

      if (PRAZO_ADICIONAL_COD === '3.4.1') FIN_3_2_MANUTENCAO_CONFORMIDADE = 'SIM';
      if (PRAZO_ADICIONAL_COD === '3.4.2') FIN_3_2_DEFICIT_ATUARIAL = 'SIM';
      if (PRAZO_ADICIONAL_COD === '3.4.3') FIN_3_2_CRITERIOS_ESTRUTURANTES = 'SIM';
      if (PRAZO_ADICIONAL_COD === '3.4.4') FIN_3_2_OUTRO_CRITERIO_COMPLEXO = 'SIM';
    }

    // === Montagem do objeto (SEM chaves duplicadas) ===
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
      ORGAO_VINCULACAO_UG: (document.getElementById('ug_orgao_vinc')?.value || '').trim(),

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

      // 3.1/3.2 (base)
      DATA_VENCIMENTO_ULTIMO_CRP: DATA_VENCIMENTO_ULTIMO_CRP,
      TIPO_EMISSAO_ULTIMO_CRP: TIPO_EMISSAO_ULTIMO_CRP,
      // compat: espelho
      DATA_VENC_ULTIMO_CRP: DATA_VENCIMENTO_ULTIMO_CRP,

      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i => i.value),

      ADESAO_SEM_IRREGULARIDADES,
      FIN_3_2_MANUTENCAO_CONFORMIDADE,
      FIN_3_2_DEFICIT_ATUARIAL,
      FIN_3_2_CRITERIOS_ESTRUTURANTES,
      FIN_3_2_OUTRO_CRITERIO_COMPLEXO,

      FASE_PROGRAMA: FASE_PROGRAMA,
      F41_OPCAO,
      F41_OPCAO_CODE: F41_OPCAO_CODE,

      // Listas já calculadas (sem recomputar aqui)
      F42_LISTA,
      F44_CRITERIOS,
      F44_DECLS,
      F44_FINALIDADES,

      F43_LISTA: collectCheckedValues('#F43_LISTA input[type="checkbox"]'),
      F43_PLANO: collectTextValue('F43_PLANO'),
      F43_PLANO_B: collectTextValue('F43_PLANO_B'),
      F43_INCLUIR: collectCheckedValues('#F43_INCLUIR input[type="checkbox"]').join('; '),
      F43_INCLUIR_B: collectCheckedValues('#F43_INCLUIR_B input[type="checkbox"]').join('; '),

      F44_ANEXOS: collectTextValue('F44_ANEXOS'),
      F45_OK451: !!$('#blk_45 input[type="checkbox"]:checked'),
      F45_DOCS:  $('#F45_DOCS')?.value || '',
      F45_JUST:  $('#F45_JUST')?.value || '',

      F46_CRITERIOS: Array.from(new Set([
        collectCheckedValues('#F46_CRITERIOS input[type="checkbox"]'),
        collectCheckedValues('#F46_CONDICOES input[type="checkbox"]'),
        collectCheckedValues('input[name="F46_CRITERIOS[]"]'),
        collectCheckedValues('input[name="fase4_6_criterios_plano[]"]')
      ].flat().filter(Boolean))),

      F46_PROGESTAO:   $('#F46_PROGESTAO')?.value || '',
      F46_PORTE:       $('#F46_PORTE')?.value || '',
      F46_JUST_D:      $('#F46_JUST_D')?.value || '',
      F46_DOCS_D:      $('#F46_DOCS_D')?.value || '',
      F46_JUST_E:      $('#F46_JUST_E')?.value || '',
      F46_DOCS_E:      $('#F46_DOCS_E')?.value || '',
      F46_FINALIDADES: collectCheckedValues('#F46_FINALIDADES input[type="checkbox"]'),
      F46_ANEXOS:      $('#F46_ANEXOS')?.value || '',
      F46_JUST_PLANOS: $('#F46_JUST_PLANOS')?.value || '',
      F46_COMP_CUMPR:  $('#F46_COMP_CUMPR')?.value || '',

      F4310_OPCAO:  document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '',
      F4310_LEGISLACAO: $('#F4310_LEGISLACAO')?.value || '',
      F4310_DOCS:       $('#F4310_DOCS')?.value || '',

      F43_DESC_PLANOS: collectTextValue('F43_DESC_PLANOS'),

      F441_LEGISLACAO: $('#F441_LEGISLACAO')?.value || '',
      F445_DESC_PLANOS: collectTextValue('F445_DESC_PLANOS'),
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
    // PORTARIA padronizada (caso não venha do formulário)
    if (!obj.PORTARIA_SRPC) obj.PORTARIA_SRPC = '2.010/2025';

    dbg('[SOLIC-CRP] Payload (parcial):', obj);
    ensureDefaultsForPayload(obj);

    // === [3.1 e 3.2] Normalização e aliases para o TERMO ===
    const byNameVal = (n) => document.querySelector(`[name="${n}"]`)?.value || '';
    const byIdVal   = (i) => document.getElementById(i)?.value || '';
    const toBR = (v)=>{
      if(!v) return '';
      const s = String(v).trim();
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
    };

    const _dataVencUltCrpRaw =
      byNameVal('DATA_VENC_ULTIMO_CRP') ||
      byNameVal('DATA_VENCIMENTO_ULTIMO_CRP') ||
      byIdVal('DATA_VENC_ULTIMO_CRP') ||
      byIdVal('DATA_VENCIMENTO_ULTIMO_CRP') ||
      byNameVal('data_venc_ult_crp') ||
      byIdVal('data_venc_ult_crp') || '';

    obj.DATA_VENC_ULTIMO_CRP = toBR(obj.DATA_VENC_ULTIMO_CRP || obj.DATA_VENCIMENTO_ULTIMO_CRP || '');
    obj.DATA_VENCIMENTO_ULTIMO_CRP = obj.DATA_VENC_ULTIMO_CRP;
    obj.venc_ult_crp               = obj.DATA_VENC_ULTIMO_CRP;   // <- data-k do termo
    obj.tipo_emissao_ult_crp       = obj.TIPO_EMISSAO_ULTIMO_CRP; // <- data-k do termo

    const _tipoEmissaoUltCrpRaw =
      byNameVal('TIPO_EMISSAO_ULTIMO_CRP') ||
      byIdVal('TIPO_EMISSAO_ULTIMO_CRP') ||
      byNameVal('tipo_emissao_ult_crp') ||
      byIdVal('tipo_emissao_ult_crp') ||
      byNameVal('tipo') || obj.TIPO_EMISSAO_ULTIMO_CRP || '';

    obj.TIPO_EMISSAO_ULTIMO_CRP = String(_tipoEmissaoUltCrpRaw).trim();
    if (/^adm/i.test(obj.TIPO_EMISSAO_ULTIMO_CRP)) obj.TIPO_EMISSAO_ULTIMO_CRP = 'Administrativa';
    if (/^jud/i.test(obj.TIPO_EMISSAO_ULTIMO_CRP)) obj.TIPO_EMISSAO_ULTIMO_CRP = 'Judicial';
    obj.tipo_emissao_ult_crp = obj.TIPO_EMISSAO_ULTIMO_CRP;     // data-k do termo

    obj.ULTIMO_CRP_DATA = obj.DATA_VENC_ULTIMO_CRP;
    obj.ULTIMO_CRP_TIPO = obj.TIPO_EMISSAO_ULTIMO_CRP;

    // Compat: objeto CRP legado (se alguma parte do backend/template ainda usa)
    obj.CRP = Object.assign({}, obj.CRP || {}, {
      data_venc: obj.DATA_VENC_ULTIMO_CRP,
      tipo:      obj.TIPO_EMISSAO_ULTIMO_CRP
    });

    // >>> aplica 3.4 no payload (sem duplicar lógica)
    obj.PRAZO_ADICIONAL_COD   = PRAZO_ADICIONAL_COD;
    obj.PRAZO_ADICIONAL_TEXTO = PRAZO_ADICIONAL_TEXTO;
    obj.PRAZO_ADICIONAL_FLAG  = obj.PRAZO_ADICIONAL_COD ? 'SIM' : 'NAO';

    // ——— Aliases com [] para agradar validações Joi do backend ———
    // MARCADOR: JOI_ARRAY_ALIASES
    ['F42_LISTA','F43_LISTA','F44_CRITERIOS','F44_DECLS','F44_FINALIDADES',
      'F46_CRITERIOS','F46_FINALIDADES','F462F_CRITERIOS','CRITERIOS_IRREGULARES'
    ].forEach(k => {
      const v = obj[k];
      const arr = Array.isArray(v) ? v : (v ? [String(v)] : []);
      obj[k+'[]'] = arr;
      // NÃO sobrescreva obj[k] — mantém o tipo original (string ou array)
    });

    // Campos que o schema exige STRING: preserva string e cria alias [] só para o template/UI
    ['F43_INCLUIR','F43_INCLUIR_B'].forEach(k => {
      const s = (obj[k] ?? '').toString();
      obj[k] = s; // mantém string
      obj[k+'[]'] = s ? s.split(';').map(t => t.trim()).filter(Boolean) : [];
    });

    // Log útil
    console.log('DEBUG buildPayload output:', {
      F44_CRITERIOS: obj.F44_CRITERIOS,
      F44_DECLS: obj.F44_DECLS,
      F44_FINALIDADES: obj.F44_FINALIDADES,
      PRAZO_ADICIONAL_TEXTO: obj.PRAZO_ADICIONAL_TEXTO,
      PRAZO_ADICIONAL_FLAG: obj.PRAZO_ADICIONAL_FLAG
    });

    // PATCH E — passo 2 (log final)
    if (window.__DEBUG_SOLIC_CRP__) {
      try {
        console.log('[E2] buildPayload() fim →', {
          DATA_VENC_ULTIMO_CRP: obj.DATA_VENC_ULTIMO_CRP || obj.DATA_VENCIMENTO_ULTIMO_CRP,
          TIPO_EMISSAO_ULTIMO_CRP: obj.TIPO_EMISSAO_ULTIMO_CRP,
          PRAZO_ADICIONAL_COD: obj.PRAZO_ADICIONAL_COD,
          PRAZO_ADICIONAL_TEXTO: obj.PRAZO_ADICIONAL_TEXTO,
          FASE_PROGRAMA: obj.FASE_PROGRAMA || obj.fase_programa
        });
      } catch {}
    }

    // no final do buildPayload(), antes do return:
    if (!obj.IDEMP_KEY) {
      obj.IDEMP_KEY = takeIdemKey() || (function(){ try{
        const a=new Uint8Array(16); crypto.getRandomValues(a);
        return 'id_'+Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');
      }catch{ return 'id_'+Math.random().toString(36).slice(2)+Date.now().toString(36); }})();
    }

    // ===== NOVO BLOCO: aliases compat/template para 3.1 / 3.2 / 3.4 =====
    obj.PRAZO_ADICIONAL_COD = obj.PRAZO_ADICIONAL_COD || '';
    obj.PRAZO_ADICIONAL_TEXTO = obj.PRAZO_ADICIONAL_TEXTO || '';

    // lowercase aliases (alguns templates / fallbacks usam chaves minúsculas)
    obj.prazo_adicional_cod = obj.PRAZO_ADICIONAL_COD;
    obj.prazo_adicional_texto = obj.PRAZO_ADICIONAL_TEXTO;

    // 3.1 aliases lowercase e espelho
    obj.data_vencimento_ultimo_crp = obj.DATA_VENCIMENTO_ULTIMO_CRP || obj.DATA_VENC_ULTIMO_CRP || obj.venc_ult_crp || '';
    obj.data_venc_ultimo_crp = obj.data_vencimento_ultimo_crp;
    obj.venc_ult_crp = obj.data_vencimento_ultimo_crp;

    // 3.2 aliases lowercase
    obj.tipo_emissao_ult_crp = obj.TIPO_EMISSAO_ULTIMO_CRP || obj.tipo_emissao_ult_crp || '';

    // espelha no window.__TERMO_DATA__ para garantir que o template receba os valores
    try {
      window.__TERMO_DATA__ = Object.assign({}, window.__TERMO_DATA__ || {}, {
        DATA_VENC_ULTIMO_CRP: obj.data_venc_ultimo_crp,
        DATA_VENCIMENTO_ULTIMO_CRP: obj.data_venc_ultimo_crp,
        venc_ult_crp: obj.venc_ult_crp,
        TIPO_EMISSAO_ULTIMO_CRP: obj.TIPO_EMISSAO_ULTIMO_CRP,
        tipo_emissao_ult_crp: obj.tipo_emissao_ult_crp,
        PRAZO_ADICIONAL_COD: obj.PRAZO_ADICIONAL_COD,
        PRAZO_ADICIONAL_TEXTO: obj.PRAZO_ADICIONAL_TEXTO
      });
      document.dispatchEvent(new Event('TERMO_DATA'));
    } catch (e) { /* não crítico */ }

    // === Mescla universal: se algo não foi preenchido manualmente acima, pega do form ===
    try {
      const form = document.querySelector('form#form_solic_crp') || document.querySelector('form');
      if (form) {
        const extra = serializeFormToPayload(form);
        
        for (const [k, v] of Object.entries(extra)) {
          const curr = obj[k];
          const isEmpty =
            curr == null ||
            (typeof curr === 'string' && curr.trim() === '') ||
            (Array.isArray(curr) && curr.length === 0);

          if (isEmpty) obj[k] = v; // só preenche o que estiver faltando
          if (Array.isArray(v)) obj[`${k}[]`] = v; // mantêm compat com chaves terminadas em []
        }
      }
    } catch (e) { /* não crítico */ }

    // PATCH (TXT aliases) — versões em texto para o template
    obj.F42_LISTA_TXT       = (obj.F42_LISTA && Array.isArray(obj.F42_LISTA)) ? obj.F42_LISTA.join('; ') : (obj.F42_LISTA || '');
    obj.F43_LISTA_TXT       = (obj.F43_LISTA && Array.isArray(obj.F43_LISTA)) ? obj.F43_LISTA.join('; ') : (obj.F43_LISTA || '');
    obj.F44_CRITERIOS_TXT   = (obj.F44_CRITERIOS && Array.isArray(obj.F44_CRITERIOS)) ? obj.F44_CRITERIOS.join('\n') : (obj.F44_CRITERIOS || '');
    obj.F44_FINALIDADES_TXT = (obj.F44_FINALIDADES && Array.isArray(obj.F44_FINALIDADES)) ? obj.F44_FINALIDADES.join('\n') : (obj.F44_FINALIDADES || '');
    obj.F44_DECLS_TXT       = (obj.F44_DECLS && Array.isArray(obj.F44_DECLS)) ? obj.F44_DECLS.join('\n') : (obj.F44_DECLS || '');
    obj.F46_CRITERIOS_TXT   = (obj.F46_CRITERIOS && Array.isArray(obj.F46_CRITERIOS)) ? obj.F46_CRITERIOS.join('\n') : (obj.F46_CRITERIOS || '');
    obj.F46_FINALIDADES_TXT = (obj.F46_FINALIDADES && Array.isArray(obj.F46_FINALIDADES)) ? obj.F46_FINALIDADES.join('\n') : (obj.F46_FINALIDADES || '');

    // Padroniza F43_INCLUIR / F43_INCLUIR_B como string SEMPRE!
    const toStr = v => {
      if (Array.isArray(v)) return v.filter(Boolean).join('; ');
      if (v === null || v === undefined) return "";
      if (typeof v === 'string') return v.trim();
      return String(v).trim();
    };

    const toArr = s => {
      if (typeof s === 'string') {
        return s.split(';').map(t => t.trim()).filter(Boolean);
      }
      if (Array.isArray(s)) {
        return s.filter(Boolean);
      }
      return [];
    };

    obj.F43_INCLUIR    = toStr(obj.F43_INCLUIR);       // SEMPRE string
    obj.F43_INCLUIR_B  = toStr(obj.F43_INCLUIR_B);     // SEMPRE string
    obj['F43_INCLUIR[]']   = toArr(obj.F43_INCLUIR);   // array sempre
    obj['F43_INCLUIR_B[]'] = toArr(obj.F43_INCLUIR_B); // array sempre
    obj.F43_INCLUIR_TXT = obj.F43_INCLUIR;

    // --- Garantia extra de tipos exigidos pelo backend ---
    if (typeof obj.F43_INCLUIR !== 'string') {
      obj.F43_INCLUIR = toStr(obj.F43_INCLUIR);
    }
    if (typeof obj.F43_INCLUIR_B !== 'string') {
      obj.F43_INCLUIR_B = toStr(obj.F43_INCLUIR_B);
    }


    return obj;
  }

  // === Compat converter → transforma os campos granulares do form 2
  //     nas chaves que o template termo_solic_crp.html espera ===
  function makeSolicCrpCompatFields(p) {
    // 4.1 (até 60 / até 300) a partir de F41_OPCAO
    let CELEBRACAO_TERMO_PARCELA_DEBITOS = '';
    const _f41 = (p.F41_OPCAO_CODE || (String(p.F41_OPCAO||'').match(/4\.1\.[12]/)?.[0] || '')).trim();
    if (_f41 === '4.1.1') CELEBRACAO_TERMO_PARCELA_DEBITOS = '4.1.1 – até 60 parcelas';
    if (_f41 === '4.1.2') CELEBRACAO_TERMO_PARCELA_DEBITOS = '4.1.2 – até 300 parcelas';

    // 4.2 regularização administrativa
    const f42 = Array.isArray(p.F42_LISTA) ? p.F42_LISTA
          : Array.isArray(p['F42_LISTA[]']) ? p['F42_LISTA[]']
          : Array.isArray(p['F42_ITENS[]']) ? p['F42_ITENS[]']
          : Array.isArray(p.F42_ITENS) ? p.F42_ITENS : [];
    const REGULARIZACAO_PENDEN_ADMINISTRATIVA = f42.join('; ');

    // 4.3 déficit atuarial
    const f43 = Array.isArray(p.F43_LISTA) ? p.F43_LISTA
          : Array.isArray(p['F43_LISTA[]']) ? p['F43_LISTA[]']
          : Array.isArray(p['F43_ITENS[]']) ? p['F43_ITENS[]']
          : Array.isArray(p.F43_ITENS) ? p.F43_ITENS : [];
    let DEFICIT_ATUARIAL = f43.join('; ');
    if (!DEFICIT_ATUARIAL && (p.F43_PLANO || p.F43_DESC_PLANOS)) {
      DEFICIT_ATUARIAL = '4.3';
    }

    // 4.4 critérios estruturantes
    const f44c = Array.isArray(p.F44_CRITERIOS) ? p.F44_CRITERIOS
          : Array.isArray(p['F44_CRITERIOS[]']) ? p['F44_CRITERIOS[]']
          : Array.isArray(p['F44_CONDICOES[]']) ? p['F44_CONDICOES[]']
          : Array.isArray(p.F44_CONDICOES) ? p.F44_CONDICOES : [];
    const CRITERIOS_ESTRUT_ESTABELECIDOS = f44c.join('; ');

    // 4.6 Manutenção da conformidade
    const man = Array.isArray(p.F46_CRITERIOS) ? p.F46_CRITERIOS : (Array.isArray(p.F46_CONDICOES) ? p.F46_CONDICOES : []);
    const MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS = man.join('; ');

    // Etapas 5–7 (textos)
    const COMPROMISSO_FIRMADO_ADESAO = String(p.F45_JUST || '').trim();
    const PROVIDENCIA_NECESS_ADESAO  = String(p.F45_DOCS || '').trim();
    const CONDICAO_VIGENCIA          = String(p.F46_JUST_PLANOS || '').trim();

    // Data
    const DATA_TERMO_GERADO = p.DATA_SOLIC_GERADA || p.DATA || '';

    // Helpers flex
    const getAllByName = (n) => Array.from(document.querySelectorAll(`[name="${n}"]`));
    const byNameValsAny = (names) =>
      names.flatMap(n =>
        getAllByName(n).map(el =>
          (el.type === 'checkbox' || el.type === 'radio')
            ? (el.checked ? (el.value || 'on') : '')
            : (el.value || '')
        )
      ).filter(Boolean);
    const byNameCheckedAny = (names) =>
      names.flatMap(n =>
        getAllByName(n)
          .filter(el => (el.type === 'checkbox' || el.type === 'radio') && el.checked)
          .map(el => el.value || 'on')
      );
    const byNameValAny = (names) => {
      for (const n of names) {
        const el = document.querySelector(`[name="${n}"]`);
        if (!el) continue;
        const v = (el.type === 'checkbox' || el.type === 'radio')
          ? (el.checked ? (el.value || 'on') : '')
          : (el.value || '');
        if (String(v).trim()) return String(v).trim();
      }
      return '';
    };

    // ===== Item 4 — Extras por fase (mapeando fase4_*  ⇄  F4x_*) =====
    const F41_EXTRA = {
      'fase4_1_criterios':             byNameCheckedAny(['fase4_1_criterios[]','F41_CRITERIOS[]','F41_CONDICOES[]']),
      'fase4_1_criterios_outros':      byNameValAny(['fase4_1_criterios_outros','F41_CRITERIOS_OUTROS','F41_OUTROS']),
      'fase4_1_declaracao_base':       byNameValAny(['fase4_1_declaracao_base','F41_DECL_BASE']),
      'fase4_1_decl_a_data':           byNameValAny(['fase4_1_decl_a_data','F41_DECL_A_DATA']),
      'fase4_1_decl_b_conf':           byNameCheckedAny(['fase4_1_decl_b_conf','F41_DECL_B_CONF']),
      'fase4_1_decl_f':                byNameCheckedAny(['fase4_1_decl_f[]','F41_DECL_F[]']),
      'fase4_1_finalidade':            byNameCheckedAny(['fase4_1_finalidade[]','F41_FINALIDADES[]']),
      'fase4_1_finalidade_protocolos': byNameValsAny(['fase4_1_finalidade_protocolos[]','F41_FINALIDADE_PROTO[]','F41_PROTO[]']),
      'fase4_1_anexos':                byNameValsAny(['fase4_1_anexos[]','F41_ANEXOS[]','F41_ANEXOS']),
      'fase4_1_anexos_desc':           byNameValsAny(['fase4_1_anexos_desc[]','F41_ANEXOS_DESC[]']),
      'fase4_1_just':                  byNameValAny(['fase4_1_just','F41_JUST']),
      'fase4_1_comp_tipo':             byNameValAny(['fase4_1_comp_tipo','F41_COMP_TIPO']),
      'fase4_1_comp_protocolo':        byNameValAny(['fase4_1_comp_protocolo','F41_COMP_PROTO']),
      'fase4_1_comp_data':             byNameValAny(['fase4_1_comp_data','F41_COMP_DATA']),
    };

    const F42_EXTRA = {
      'fase4_2_criterios':             byNameCheckedAny(['fase4_2_criterios[]','F42_CRITERIOS[]','F42_LISTA[]']),
      'fase4_2_decl':                  byNameValAny(['fase4_2_decl','F42_DECL']),
      'fase4_2_decl_a_lei':            byNameValAny(['fase4_2_decl_a_lei','F42_DECL_A_LEI']),
      'fase4_2_decl_b_prazo':          byNameValAny(['fase4_2_decl_b_prazo','F42_DECL_B_PRAZO']),
      'fase4_2_decl_f':                byNameCheckedAny(['fase4_2_decl_f[]','F42_DECL_F[]']),
      'fase4_2_finalidade':            byNameValAny(['fase4_2_finalidade','F42_FINALIDADE']),
      'fase4_2_prazo_req':             byNameValAny(['fase4_2_prazo_req','F42_PRAZO_REQ']),
      'fase4_2_prazo_fund':            byNameValAny(['fase4_2_prazo_fund','F42_PRAZO_FUND']),
      'fase4_2_anexos':                byNameValsAny(['fase4_2_anexos[]','F42_ANEXOS[]','F42_ANEXOS']),
      'fase4_2_anexos_desc':           byNameValsAny(['fase4_2_anexos_desc[]','F42_ANEXOS_DESC[]']),
      'fase4_2_just':                  byNameValAny(['fase4_2_just','F42_JUST']),
      'fase4_2_comp_tipo':             byNameValAny(['fase4_2_comp_tipo','F42_COMP_TIPO']),
      'fase4_2_comp_num':              byNameValAny(['fase4_2_comp_num','F42_COMP_NUM']),
      'fase4_2_comp_data':             byNameValAny(['fase4_2_comp_data','F42_COMP_DATA']),
    };

    const F43_EXTRA = {
      'fase4_3_escopo':                byNameCheckedAny(['fase4_3_escopo[]','F43_ESCOPO[]']),
      'fase4_3_eq_massa_alvo':         byNameCheckedAny(['fase4_3_eq_massa_alvo[]','F43_MASSA[]']),
      'fase4_3_eq_crono':              byNameValAny(['fase4_3_eq_crono','F43_CRONO']),
      'fase4_3_eq_indicadores':        byNameCheckedAny(['fase4_3_eq_indicadores[]','F43_INDICADORES[]']),
      'fase4_3_eq_indicadores_outros': byNameValAny(['fase4_3_eq_indicadores_outros','F43_INDICADORES_OUTROS']),
      'fase4_3_decl':                  byNameValAny(['fase4_3_decl','F43_DECL']),
      'fase4_3_decl_a_param':          byNameValAny(['fase4_3_decl_a_param','F43_DECL_A_PARAM']),
      'fase4_3_decl_f':                byNameCheckedAny(['fase4_3_decl_f[]','F43_DECL_F[]']),
      'fase4_3_finalidade':            byNameCheckedAny(['fase4_3_finalidade[]','F43_FINALIDADES[]']),
      'fase4_3_alt_detalhe':           byNameValAny(['fase4_3_alt_detalhe','F43_ALT_DET']),
      'fase4_3_anexos':                byNameValsAny(['fase4_3_anexos[]','F43_ANEXOS[]','F43_ANEXOS']),
      'fase4_3_anexos_desc':           byNameValsAny(['fase4_3_anexos_desc[]','F43_ANEXOS_DESC[]']),
      'fase4_3_just':                  byNameValAny(['fase4_3_just','F43_JUST']),
      'fase4_3_comp_tipo':             byNameValAny(['fase4_3_comp_tipo','F43_COMP_TIPO']),
      'fase4_3_comp_num':              byNameValAny(['fase4_3_comp_num','F43_COMP_NUM']),
      'fase4_3_comp_data':             byNameValAny(['fase4_3_comp_data','F43_COMP_DATA']),
    };

    const F44_EXTRA = {
      'fase4_4_debitos_massa':         byNameCheckedAny(['fase4_4_debitos_massa[]','F44_CONDICOES[]','F44_DEBITOS[]']),
      'fase4_4_debitos_outros':        byNameValAny(['fase4_4_debitos_outros','F44_DEBITOS_OUTROS']),
      'fase4_4_vinc_fpm':              byNameValAny(['fase4_4_vinc_fpm','F44_VINC_FPM']),
      'fase4_4_vinc_lei':              byNameValAny(['fase4_4_vinc_lei','F44_VINC_LEI']),
      'fase4_4_vinc_proc':             byNameValAny(['fase4_4_vinc_proc','F44_VINC_PROC']),
      'fase4_4_comp_tipo':             byNameValAny(['fase4_4_comp_tipo','F44_COMP_TIPO']),
      'fase4_4_comp_dipr_num':         byNameValAny(['fase4_4_comp_dipr_num','F44_COMP_DIPR_NUM']),
      'fase4_4_comp_dipr_data':        byNameValAny(['fase4_4_comp_dipr_data','F44_COMP_DIPR_DATA']),
      'fase4_4_anexos':                byNameValsAny(['fase4_4_anexos[]','F44_ANEXOS[]','F44_ANEXOS']),
      'fase4_4_anexos_desc':           byNameValsAny(['fase4_4_anexos_desc[]','F44_ANEXOS_DESC[]']),
      'fase4_4_just':                  byNameValAny(['fase4_4_just','F44_JUST']),
      'fase4_4_comp_final_tipo':       byNameValAny(['fase4_4_comp_final_tipo','F44_COMP_FINAL_TIPO']),
      'fase4_4_comp_final_num':        byNameValAny(['fase4_4_comp_final_num','F44_COMP_FINAL_NUM']),
      'fase4_4_comp_final_data':       byNameValAny(['fase4_4_comp_final_data','F44_COMP_FINAL_DATA']),
    };

    const F45_EXTRA = {
      'fase4_5_criterios':             byNameCheckedAny(['fase4_5_criterios[]','F45_CRITERIOS[]']),
      'fase4_5_decl':                  byNameValAny(['fase4_5_decl','F45_DECL']),
      'fase4_5_decl_a_dtcrp_ult':      byNameValAny(['fase4_5_decl_a_dtcrp_ult','F45_DECL_A_DTCRP_ULT']),
      'fase4_5_decl_b_tipo':           byNameValAny(['fase4_5_decl_b_tipo','F45_DECL_B_TIPO']),
      'fase4_5_decl_f':                byNameCheckedAny(['fase4_5_decl_f[]','F45_DECL_F[]']),
      'fase4_5_finalidade':            byNameCheckedAny(['fase4_5_finalidade[]','F45_FINALIDADES[]']),
      'fase4_5_crp_info':              byNameValAny(['fase4_5_crp_info','F45_CRP_INFO']),
      'fase4_5_anexos':                byNameValsAny(['fase4_5_anexos[]','F45_ANEXOS[]','F45_ANEXOS']),
      'fase4_5_anexos_desc':           byNameValsAny(['fase4_5_anexos_desc[]','F45_ANEXOS_DESC[]']),
      'fase4_5_just':                  byNameValAny(['fase4_5_just','F45_JUST']),
      'fase4_5_comp_tipo':             byNameValAny(['fase4_5_comp_tipo','F45_COMP_TIPO']),
      'fase4_5_comp_num':              byNameValAny(['fase4_5_comp_num','F45_COMP_NUM']),
      'fase4_5_comp_data':             byNameValAny(['fase4_5_comp_data','F45_COMP_DATA']),
    };

    const F46_EXTRA = {
      'fase4_6_criterios_plano':       byNameCheckedAny(['fase4_6_criterios_plano[]','F46_CONDICOES[]','F46_CRITERIOS[]']),
      'fase4_6_pg_nivel':              byNameValAny(['fase4_6_pg_nivel','F46_PG_NIVEL']),
      'fase4_6_criterios_outros':      byNameValAny(['fase4_6_criterios_outros','F46_CRITERIOS_OUTROS']),
      'fase4_6_declaracoes':           byNameValAny(['fase4_6_declaracoes','F46_DECLARACOES','F46_DECLS_TXT']),
      'fase4_6_decl_a_base':           byNameValAny(['fase4_6_decl_a_base','F46_DECL_A_BASE']),
      'fase4_6_decl_b_conferencia':    byNameCheckedAny(['fase4_6_decl_b_conferencia','F46_DECL_B_CONF']),
      'fase4_6_crit_f':                byNameCheckedAny(['fase4_6_crit_f[]','F46_CRIT_F[]']),
      'fase4_6_finalidade':            byNameCheckedAny(['fase4_6_finalidade[]','F46_FINALIDADES[]']),
      'fase4_6_alt_crono':             byNameValAny(['fase4_6_alt_crono','F46_ALT_CRONO']),
      'fase4_6_alt_kpi':               byNameCheckedAny(['fase4_6_alt_kpi[]','F46_ALT_KPI[]']),
      'fase4_6_prazo_data':            byNameValAny(['fase4_6_prazo_data','F46_PRAZO_DATA']),
      'fase4_6_prazo_fund':            byNameValAny(['fase4_6_prazo_fund','F46_PRAZO_FUND']),
      'fase4_6_anexos':                byNameValsAny(['fase4_6_anexos[]','F46_ANEXOS[]','F46_ANEXOS']),
      'fase4_6_anexos_desc':           byNameValsAny(['fase4_6_anexos_desc[]','F46_ANEXOS_DESC[]']),
      'fase4_6_anexos_tipo':           byNameValAny(['fase4_6_anexos_tipo','F46_ANEXOS_TIPO']),
      'fase4_6_anexos_ref':            byNameValAny(['fase4_6_anexos_ref','F46_ANEXOS_REF']),
      'fase4_6_just':                  byNameValAny(['fase4_6_just','F46_JUST']),
      'fase4_6_comp':                  byNameValAny(['fase4_6_comp','F46_COMP']),
      'fase4_6_comp_kpi':              byNameCheckedAny(['fase4_6_comp_kpi[]','F46_COMP_KPI[]']),
      'fase4_6_comp_kpi_arq':          byNameValsAny(['fase4_6_comp_kpi_arq[]','F46_COMP_KPI_ARQ[]']),
      'fase4_6_comp_num':              byNameValAny(['fase4_6_comp_num','F46_COMP_NUM']),
      'fase4_6_comp_data':             byNameValAny(['fase4_6_comp_data','F46_COMP_DATA']),
    };

    const FASE4_EXTRAS = { ...F41_EXTRA, ...F42_EXTRA, ...F43_EXTRA, ...F44_EXTRA, ...F45_EXTRA, ...F46_EXTRA };

    const F451_TEXTO =
      (p.F45_OK451 === true || p.F45_OK451 === 'true')
        ? 'Foi mantida a regularidade quanto aos critérios exigidos nas fases anteriores.'
        : 'Não informado';

    const F46_CRITERIOS   = Array.isArray(p.F46_CRITERIOS)   ? p.F46_CRITERIOS
                          : Array.isArray(p.F44_CRITERIOS)  ? p.F44_CRITERIOS : [];
    const F46_DECLS       = Array.isArray(p.F46_DECLS)       ? p.F46_DECLS
                          : Array.isArray(p.F44_DECLS)      ? p.F44_DECLS : [];
    const F46_FINALIDADES = Array.isArray(p.F46_FINALIDADES) ? p.F46_FINALIDADES
                          : Array.isArray(p.F44_FINALIDADES)? p.F44_FINALIDADES : [];

    const F46_CRITERIOS_TXT   = F46_CRITERIOS.length ? F46_CRITERIOS.join('\n') : 'Não informado';
    const F46_DECLS_TXT       = F46_DECLS.length ? F46_DECLS.join('\n') : 'Não informado';
    const F46_FINALIDADES_TXT = F46_FINALIDADES.length ? F46_FINALIDADES.join('\n') : 'Não informado';

    return {
      CELEBRACAO_TERMO_PARCELA_DEBITOS,
      F41_OPCAO_TXT: CELEBRACAO_TERMO_PARCELA_DEBITOS,
      FASE_41_DESC:  CELEBRACAO_TERMO_PARCELA_DEBITOS,

      REGULARIZACAO_PENDEN_ADMINISTRATIVA,
      DEFICIT_ATUARIAL,
      CRITERIOS_ESTRUT_ESTABELECIDOS,
      MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS,

      COMPROMISSO_FIRMADO_ADESAO,
      PROVIDENCIA_NECESS_ADESAO,
      CONDICAO_VIGENCIA,

      DATA_TERMO_GERADO,
      ESFERA: p.ESFERA || '',

      // 4.5
      F451_TEXTO,
      F45_DOCS: p.F45_DOCS || 'Não informado',
      F45_JUST: p.F45_JUST || 'Não informado',

      // 4.6 – arrays e versões em texto
      F46_CRITERIOS,
      F46_DECLS,
      F46_FINALIDADES,
      F46_CRITERIOS_TXT,
      F46_DECLS_TXT,
      F46_FINALIDADES_TXT,
      'F46_CRITERIOS[]':   F46_CRITERIOS,
      'F46_DECLS[]':       F46_DECLS,
      'F46_FINALIDADES[]': F46_FINALIDADES,

      // extras esperados pelo template
      ...FASE4_EXTRAS,
    };
  }

  // PATCH (F4-TEMPLATE) — garante arrays E versões em texto nas chaves esperadas pelo template
  function __stringifyList(v, sep = '; ') {
    if (!v) return '';
    if (Array.isArray(v)) return v.filter(Boolean).join(sep);
    return String(v || '').trim();
  }

  function mirrorFase4ToTermoData(payload, compat) {
    try {
      const TD = window.__TERMO_DATA__ = Object.assign({}, window.__TERMO_DATA__ || {}, {
      FASE_PROGRAMA: payload.FASE_PROGRAMA || (window.__TERMO_DATA__ && window.__TERMO_DATA__.FASE_PROGRAMA) || '',
      __FASE_SEL__:  payload.FASE_PROGRAMA || (window.__TERMO_DATA__ && window.__TERMO_DATA__.__FASE_SEL__) || '',
        // 4.1
        CELEBRACAO_TERMO_PARCELA_DEBITOS: compat.CELEBRACAO_TERMO_PARCELA_DEBITOS || '',
        F41_OPCAO_TXT: compat.F41_OPCAO_TXT || '',
        FASE_41_DESC:  compat.FASE_41_DESC  || '',

        // 4.2
        'F42_LISTA[]':        payload.F42_LISTA || [],
        F42_LISTA:            payload.F42_LISTA || [],
        F42_LISTA_TXT:        __stringifyList(payload.F42_LISTA),

        // 4.3
        'F43_LISTA[]':        payload.F43_LISTA || [],
        F43_LISTA:            payload.F43_LISTA || [],
        F43_LISTA_TXT:        __stringifyList(payload.F43_LISTA),
        F43_PLANO:            payload.F43_PLANO || '',
        F43_PLANO_B:          payload.F43_PLANO_B || '',
        F43_INCLUIR:          payload.F43_INCLUIR || '',
        'F43_INCLUIR[]':      (payload['F43_INCLUIR[]'] || []),
        F43_DESC_PLANOS:      payload.F43_DESC_PLANOS || '',
        F4310_OPCAO:          payload.F4310_OPCAO || '',
        F4310_LEGISLACAO:     payload.F4310_LEGISLACAO || '',
        F4310_DOCS:           payload.F4310_DOCS || '',

        // 4.4
        'F44_CRITERIOS[]':    payload.F44_CRITERIOS || [],
        F44_CRITERIOS:        payload.F44_CRITERIOS || [],
        F44_CRITERIOS_TXT:    __stringifyList(payload.F44_CRITERIOS, '\n'),
        'F44_FINALIDADES[]':  payload.F44_FINALIDADES || [],
        F44_FINALIDADES:      payload.F44_FINALIDADES || [],
        F44_FINALIDADES_TXT:  __stringifyList(payload.F44_FINALIDADES, '\n'),
        'F44_DECLS[]':        payload.F44_DECLS || [],
        F44_DECLS:            payload.F44_DECLS || [],
        F44_DECLS_TXT:        __stringifyList(payload.F44_DECLS, '\n'),
        F44_ANEXOS:           payload.F44_ANEXOS || '',
        F441_LEGISLACAO:      payload.F441_LEGISLACAO || '',
        F445_DESC_PLANOS:     payload.F445_DESC_PLANOS || '',
        F446_DOCS:            payload.F446_DOCS || '',
        F446_EXEC_RES:        payload.F446_EXEC_RES || '',

        // 4.5
        F451_TEXTO:           compat.F451_TEXTO || '',
        F45_DOCS:             payload.F45_DOCS || '',
        F45_JUST:             payload.F45_JUST || '',
        F453_EXEC_RES:        payload.F453_EXEC_RES || '',

        // 4.6
        'F46_CRITERIOS[]':    payload.F46_CRITERIOS || [],
        F46_CRITERIOS:        payload.F46_CRITERIOS || [],
        F46_CRITERIOS_TXT:    __stringifyList(payload.F46_CRITERIOS, '\n'),
        'F46_FINALIDADES[]':  payload.F46_FINALIDADES || [],
        F46_FINALIDADES:      payload.F46_FINALIDADES || [],
        F46_FINALIDADES_TXT:  __stringifyList(payload.F46_FINALIDADES, '\n'),
        'F462F_CRITERIOS[]':  payload.F462F_CRITERIOS || [],
        F462F_CRITERIOS:      payload.F462F_CRITERIOS || [],
        F46_PROGESTAO:        payload.F46_PROGESTAO || '',
        F46_PORTE:            payload.F46_PORTE || '',
        F46_JUST_D:           payload.F46_JUST_D || '',
        F46_DOCS_D:           payload.F46_DOCS_D || '',
        F46_JUST_E:           payload.F46_JUST_E || '',
        F46_DOCS_E:           payload.F46_DOCS_E || '',
        F46_ANEXOS:           payload.F46_ANEXOS || '',
        F46_JUST_PLANOS:      payload.F46_JUST_PLANOS || '',
        F46_COMP_CUMPR:       payload.F46_COMP_CUMPR || '',
        F466_DOCS:            payload.F466_DOCS || '',
        F466_EXEC_RES:        payload.F466_EXEC_RES || ''
      });

      document.dispatchEvent(new Event('TERMO_DATA'));
    } catch (e) {
      console.warn('mirrorFase4ToTermoData fail:', e);
    }
  }

  // --- INÍCIO: collectFase4IntoPayload (coleta inputs dos modais fora do <form>) ---
  function collectFase4IntoPayload(payload) {
    // Helpers
    const qsa = (sel) => Array.from(document.querySelectorAll(sel));
    const readId = (id) => document.getElementById(id)?.value?.trim() || '';
    const makeText = (arr, sep = '; ') =>
      (Array.isArray(arr) && arr.length ? arr.filter(Boolean).join(sep) : '');

    // 1) Captura genérica de TODOS os inputs name^="F4"
    //    - checkbox/[] → arrays
    //    - radio → valor único
    //    - text/select → valor único
    const allF4Inputs = qsa('input[name^="F4"], select[name^="F4"], textarea[name^="F4"]');

    // Normalizar por name
    const buckets = {};
    for (const el of allF4Inputs) {
      const name = el.getAttribute('name');
      if (!name) continue;

      const isArray = name.endsWith('[]');
      const base = isArray ? name : name; // manter a chave como está (com [] quando houver)

      // checkbox (array)
      if (el.type === 'checkbox') {
        if (!isArray) {
          // checkbox simples não-array
          if (el.checked) {
            payload[name] = (payload[name] ?? '') || 'SIM';
          } else {
            payload[name] = payload[name] ?? '';
          }
        } else {
          if (!buckets[base]) buckets[base] = [];
          if (el.checked) buckets[base].push(el.value);
        }
        continue;
      }

      // radio
      if (el.type === 'radio') {
        if (el.checked) payload[name] = el.value;
        else payload[name] = payload[name] ?? '';
        continue;
      }

      // demais (text, textarea, select-one)
      const val = (el.value ?? '').trim();
      // manter o último preenchido; se vazio, não sobrescreve caso já exista
      if (val) payload[name] = val;
      else payload[name] = payload[name] ?? '';
    }

    // Despejar buckets de arrays no payload
    for (const [k, arr] of Object.entries(buckets)) {
      payload[k] = arr;
    }
    

    // 2) Compatibilidades / variações usadas no HTML
    //    (garantir que os aliases existam, mesmo que sob nomes alternativos no form)
    const alias = (prim, ...alts) => {
      if (Array.isArray(payload[prim]) ? payload[prim].length : payload[prim]) return;
      for (const a of alts) {
        if (Array.isArray(payload[a]) ? payload[a].length : payload[a]) {
          payload[prim] = payload[a];
          return;
        }
      }
      // default
      if (prim.endsWith('[]')) payload[prim] = payload[prim] || [];
      else payload[prim] = payload[prim] || '';
    };

    alias('F43_INCLUIR[]', 'F43_INCLUIR_B[]');
    alias('F44_CRITERIOS[]', 'F44_CRITERIOS');

    // 3) Leitura por ID dos campos livres (garantia extra)
    [
      'F4310_LEGISLACAO','F4310_DOCS',
      'F43_PLANO','F43_PLANO_B','F43_DESC_PLANOS',
      'F44_ANEXOS','F45_DOCS',
      'F441_LEGISLACAO','F441_DOCS',
      'F442_DOCS','F443_DOCS',
      'F461_DOCS','F462_DOCS',
    ].forEach(id => {
      const v = readId(id);
      if (v) payload[id] = v; else payload[id] = payload[id] ?? '';
    });

    // 4) Derivações “*_LISTA / *_TXT” esperadas no template/espelhos
    //    4.2
    payload.F42_LISTA = payload['F42_ITENS[]'] || payload.F42_LISTA || [];
    payload.F42_LISTA_TXT = makeText(payload.F42_LISTA);

    //    4.3
    payload.F43_LISTA = payload['F43_ITENS[]'] || payload.F43_LISTA || [];
    payload.F43_LISTA_TXT = makeText(payload.F43_LISTA);

    // F43_INCLUIR → sempre STRING para casar com o Joi do backend
    const f43InclArrRaw = payload['F43_INCLUIR[]'] || payload.F43_INCLUIR || [];
    const f43InclArr = Array.isArray(f43InclArrRaw)
      ? f43InclArrRaw.filter(Boolean)
      : (f43InclArrRaw ? [String(f43InclArrRaw)] : []);

    payload.F43_INCLUIR = f43InclArr.length ? f43InclArr.join('; ') : '';
    payload.F43_INCLUIR_TXT = payload.F43_INCLUIR;

    //    4.4
    payload.F44_LISTA_CRITERIOS = payload['F44_CRITERIOS[]'] || payload.F44_LISTA_CRITERIOS || [];

    payload.F44_LISTA_CRITERIOS_TXT = makeText(payload.F44_LISTA_CRITERIOS);

    // Sublistas de finalidades 4.4.x / 4.5 / 4.6 (usadas nos espelhos)
    const ensureList = (k) => (payload[k] = Array.isArray(payload[k]) ? payload[k] : (payload[k] ? [payload[k]] : []));
    [
      'F441_FINALIDADES[]','F442_FINALIDADES[]','F443_FINALIDADES[]','F444_FINALIDADES[]',
      'F45_FINALIDADES[]','F462_FINALIDADES[]'
    ].forEach(k => ensureList(k));

    payload.F441_FINALIDADES_TXT = makeText(payload['F441_FINALIDADES[]']);
    payload.F442_FINALIDADES_TXT = makeText(payload['F442_FINALIDADES[]']);
    payload.F443_FINALIDADES_TXT = makeText(payload['F443_FINALIDADES[]']);
    payload.F444_FINALIDADES_TXT = makeText(payload['F444_FINALIDADES[]']);
    payload.F45_FINALIDADES_TXT  = makeText(payload['F45_FINALIDADES[]']);
    payload.F462_FINALIDADES_TXT = makeText(payload['F462_FINALIDADES[]']);

    // 5) Radios simples (garantia de string vazia se não marcado)
    payload.F41_OPCAO      = payload.F41_OPCAO      || (document.querySelector('input[name="F41_OPCAO"]:checked')?.value || '');
    payload.F4310_OPCAO    = payload.F4310_OPCAO    || (document.querySelector('input[name="F4310_OPCAO"]:checked')?.value || '');

    // 6) Checkbox simples (SIM/nada)
    payload.F43_SOLICITA_INCLUSAO = document.getElementById('F43_SOLICITA_INCLUSAO')?.checked ? 'SIM' : (payload.F43_SOLICITA_INCLUSAO || '');

    // ==========================================================================
    // 6.5) Normalizações de nome (CORREÇÃO CRÍTICA)
    // Garante a cópia dos arrays do HTML (ITENS/CONDICOES) para o Payload (LISTA/DECLS/CRITERIOS),
    // corrigindo a falha onde a verificação `!payload.XXX` era falsa se `payload.XXX` fosse `[]`.
    // ==========================================================================

    // --- FASE 4.2 ---
    // Mapeia F42_ITENS[] (HTML) para F42_LISTA (PDF)
    if (!payload.F42_LISTA || payload.F42_LISTA.length === 0) {
      if (Array.isArray(payload['F42_ITENS[]']) && payload['F42_ITENS[]'].length > 0) {
        payload.F42_LISTA = payload['F42_ITENS[]'];
        payload['F42_LISTA[]'] = payload['F42_ITENS[]'];
      }
    }

    // --- FASE 4.3 (Correção principal) ---
    // Mapeia F43_ITENS[] (HTML) para F43_LISTA (PDF)
    if (!payload.F43_LISTA || payload.F43_LISTA.length === 0) {
      // Prioriza 'F43_LISTA[]' se existir (nome mais novo)
      if (Array.isArray(payload['F43_LISTA[]']) && payload['F43_LISTA[]'].length > 0) {
        payload.F43_LISTA = payload['F43_LISTA[]'];
      }
      // Fallback para 'F43_ITENS[]' (nome legado)
      else if (Array.isArray(payload['F43_ITENS[]']) && payload['F43_ITENS[]'].length > 0) {
        payload.F43_LISTA = payload['F43_ITENS[]'];
        payload['F43_LISTA[]'] = payload['F43_ITENS[]'];
      }
    }

    // --- FASE 4.4 ---
    // 1. Mapeia F44_CONDICOES[] (HTML) para F44_DECLS (PDF - Declarações)
    if (!payload.F44_DECLS || payload.F44_DECLS.length === 0) {
       if (Array.isArray(payload['F44_CONDICOES[]']) && payload['F44_CONDICOES[]'].length > 0) {
         payload.F44_DECLS = payload['F44_CONDICOES[]'];
         payload['F44_DECLS[]'] = payload['F44_CONDICOES[]'];
       }
    }
    // 2. Mapeia F44_CONDICOES[] ou F44_CRITERIOS[] para F44_CRITERIOS (PDF)
    if (!payload.F44_CRITERIOS || payload.F44_CRITERIOS.length === 0) {
       if (Array.isArray(payload['F44_CRITERIOS[]']) && payload['F44_CRITERIOS[]'].length > 0) {
         payload.F44_CRITERIOS = payload['F44_CRITERIOS[]'];
       } else if (Array.isArray(payload['F44_CONDICOES[]']) && payload['F44_CONDICOES[]'].length > 0) {
         // Fallback se F44_CRITERIOS[] não foi usado, mas CONDICOES[] sim
         payload.F44_CRITERIOS = payload['F44_CONDICOES[]'];
         payload['F44_CRITERIOS[]'] = payload['F44_CONDICOES[]'];
       }
    }


    // --- FASE 4.5 ---
    // Mapeia F45_CONDICOES[] (HTML) para F45_DECLS (PDF)
    if (!payload.F45_DECLS || payload.F45_DECLS.length === 0) {
      if (Array.isArray(payload['F45_DECLS[]']) && payload['F45_DECLS[]'].length > 0) {
        payload.F45_DECLS = payload['F45_DECLS[]'];
      } else if (Array.isArray(payload['F45_CONDICOES[]']) && payload['F45_CONDICOES[]'].length > 0) {
        payload.F45_DECLS = payload['F45_CONDICOES[]'];
        payload['F45_DECLS[]'] = payload['F45_CONDICOES[]'];
      }
    }

    // --- FASE 4.6 ---
    // Mapeia F46_CONDICOES[] (HTML) para F46_DECLS/F46_CRITERIOS (PDF)
    if (!payload.F46_DECLS || payload.F46_DECLS.length === 0) {
      if (Array.isArray(payload['F46_DECLS[]']) && payload['F46_DECLS[]'].length > 0) {
        payload.F46_DECLS = payload['F46_DECLS[]'];
      } else if (Array.isArray(payload['F46_CONDICOES[]']) && payload['F46_CONDICOES[]'].length > 0) {
        payload.F46_DECLS = payload['F46_CONDICOES[]'];
        payload['F46_DECLS[]'] = payload['F46_CONDICOES[]'];
      }
    }
    if (!payload.F46_CRITERIOS || payload.F46_CRITERIOS.length === 0) {
      if (Array.isArray(payload['F46_CRITERIOS[]']) && payload['F46_CRITERIOS[]'].length > 0) {
        payload.F46_CRITERIOS = payload['F46_CRITERIOS[]'];
      } else if (Array.isArray(payload['F46_CONDICOES[]']) && payload['F46_CONDICOES[]'].length > 0) {
        // Fallback: Se F46_CRITERIOS estiver vazio, usa as condições
        payload.F46_CRITERIOS = payload['F46_CONDICOES[]'];
        payload['F46_CRITERIOS[]'] = payload['F46_CONDICOES[]'];
      }
    }

    // Garantias finais (arrays nunca nulos para Joi/Schema)
    if (!Array.isArray(payload['F42_LISTA[]'])) payload['F42_LISTA[]'] = payload['F42_LISTA[]'] || [];
    if (!Array.isArray(payload['F43_LISTA[]'])) payload['F43_LISTA[]'] = payload['F43_LISTA[]'] || [];
    if (!Array.isArray(payload['F44_DECLS[]'])) payload['F44_DECLS[]'] = payload['F44_DECLS[]'] || [];
    if (!Array.isArray(payload['F44_CRITERIOS[]'])) payload['F44_CRITERIOS[]'] = payload['F44_CRITERIOS[]'] || [];
    if (!Array.isArray(payload['F45_DECLS[]'])) payload['F45_DECLS[]'] = payload['F45_DECLS[]'] || [];
    if (!Array.isArray(payload['F46_DECLS[]'])) payload['F46_DECLS[]'] = payload['F46_DECLS[]'] || [];
    if (!Array.isArray(payload['F46_CRITERIOS[]'])) payload['F46_CRITERIOS[]'] = payload['F46_CRITERIOS[]'] || [];
  }


  /* ========= Fluxo ÚNICO/ROBUSTO de PDF (via backend) ========= */
  async function gerarBaixarPDF(payload){
    stashPayloadForPreview(payload);

    // Garantia extra para a 4.3.11 e 4.3.12 no PDF
    if (Array.isArray(payload['F43_INCLUIR[]']) && !payload.F43_INCLUIR) {
      payload.F43_INCLUIR = payload['F43_INCLUIR[]'].join('; ');
    }
    if (Array.isArray(payload['F43_INCLUIR_B[]']) && !payload.F43_INCLUIR_B) {
      payload.F43_INCLUIR_B = payload['F43_INCLUIR_B[]'].join('; ');
    }

    const payloadForPdf = {
      ...payload,
      ...makeSolicCrpCompatFields(payload),
      __NA_LABEL: 'Não informado',
      HAS_TERMO_ENC_GESCON: payload.HAS_TERMO_ENC_GESCON ? '1' : '',
      DATA: payload.DATA_SOLIC_GERADA || payload.DATA || '',
      PORTARIA_SRPC: '2.024/2025',
      data_vencimento_ultimo_crp: (
        payload.DATA_VENCIMENTO_ULTIMO_CRP ||
        payload.DATA_VENC_ULTIMO_CRP ||
        payload.venc_ult_crp || ''
      ),
      tipo_emissao_ult_crp: (
        payload.TIPO_EMISSAO_ULTIMO_CRP ||
        payload.tipo_emissao_ult_crp || ''
      ),
      PRAZO_ADICIONAL_TEXTO: (payload.PRAZO_ADICIONAL_FLAG === 'SIM' ? 'SIM' : ''),
    };

    // 🔥 Aquece o backend/Puppeteer ANTES de pedir o PDF (evita 502/restart)
    try {
      await fetchJSON(api('/warmup'), {}, { label: 'warmup', timeout: 8000, retries: 1 });
    } catch (_) { /* segue se warmup falhar */ }

    // Garante que o serviço está de pé (proxy → backend)
    await waitForService({ timeoutMs: 60000, pollMs: 1500 });

    const tryUrls = [
      api('/termo-solic-crp-pdf') // rota do backend via proxy
    ];

    // PATCH (fill missing F4 keys) — cria chaves vazias para evitar "undefined"
    [
      'F42_LISTA','F42_LISTA_TXT',
      'F43_LISTA','F43_LISTA_TXT','F43_PLANO','F43_PLANO_B','F43_INCLUIR','F43_DESC_PLANOS',
      'F44_CRITERIOS','F44_CRITERIOS_TXT','F44_FINALIDADES','F44_FINALIDADES_TXT','F44_DECLS','F44_DECLS_TXT','F44_ANEXOS','F441_LEGISLACAO','F445_DESC_PLANOS','F446_DOCS','F446_EXEC_RES',
      'F451_TEXTO','F45_DOCS','F45_JUST','F453_EXEC_RES','F45_DECLS','F46_DECLS',
      'F46_CRITERIOS','F46_CRITERIOS_TXT','F46_FINALIDADES','F46_FINALIDADES_TXT',
      'F46_PROGESTAO','F46_PORTE','F46_JUST_D','F46_DOCS_D','F46_JUST_E','F46_DOCS_E','F46_ANEXOS','F46_JUST_PLANOS','F46_COMP_CUMPR','F466_DOCS','F466_EXEC_RES'
    ].forEach(k=>{
      if (payloadForPdf[k] == null) payloadForPdf[k] = Array.isArray(payloadForPdf[k]) ? [] : '';
    });

    const blob = await fetchBinary(
      tryUrls[0],
      {
        method: 'POST',
        headers: withKey({ 'Content-Type': 'application/json; charset=utf-8' }),
        body: JSON.stringify(payloadForPdf)
      },
      { label: 'termo-solic-crp-pdf', timeout: 90000, retries: 3 }
    );

    // download do PDF
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const enteSlug = String(payload.ENTE || 'solic-crp')
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
      .toLowerCase();
    a.href = url; a.download = `solic-crp-${enteSlug}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 0);
  }

  /* ========= Ações: Gerar & Submit ========= */
  let gerarBusy = false;
  el.btnGerar?.addEventListener('click', async () => {
    if (gerarBusy) return;
    if (!validarCamposBasicos()) return;
    const vf = validarFaseSelecionada();
    if (!vf.ok) { showAtencao([vf.motivo]); return; }

    gerarBusy = true;
    el.btnGerar.disabled = true;

    // 1. DECLARAÇÃO: Mover 'payload' para fora do bloco try
    let payload = null; 

    try {
      fillNowHiddenFields();
      
      // 2. ATRIBUIÇÃO: Agora apenas atribui o valor (sem 'const')
      payload = buildPayload(); 
      collectFase4IntoPayload(payload);

      if (window.__DEBUG_SOLIC_CRP__) {
        try {
          console.log('[solic_crp] buildPayload() (PDF) →', JSON.stringify(payload, null, 2));
        } catch (e) {
          console.warn('[solic_crp] falha ao serializar payload (PDF)', e);
        }
      }

      console.log('DEBUG payload (pre-send):', {
        F44_CRITERIOS: payload.F44_CRITERIOS,
        F44_DECLS: payload.F44_DECLS,
        F44_FINALIDADES: payload.F44_FINALIDADES,
        PRAZO_ADICIONAL_TEXTO: payload.PRAZO_ADICIONAL_TEXTO,
        PRAZO_ADICIONAL_FLAG: payload.PRAZO_ADICIONAL_FLAG
      });

      const md = bootstrap.Modal.getOrCreateInstance($('#modalGerandoPdf'));
      md.show();
      await gerarBaixarPDF(payload);
      md.hide();
      bootstrap.Modal.getOrCreateInstance($('#modalSucesso')).show();

    } catch (e) {
      bootstrap.Modal.getOrCreateInstance($('#modalGerandoPdf')).hide();
      showErro(friendlyErrorMessages(e, 'Não foi possível gerar o PDF.'));
      
      // ✅ CORRIGIDO: Agora 'payload' está acessível no catch
      if (payload) {
        openPreviewWindow(payload);
      }
    } finally {
      el.btnGerar.disabled = false;
      gerarBusy = false;
    }
  });

  // ——— SUBMIT ———
  const form = $('#solicCrpForm');
  form?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if (!validarCamposBasicos()) return;

    const vf = validarFaseSelecionada();
    if (!vf.ok) { showAtencao([vf.motivo]); return; }

    fillNowHiddenFields();

    const idem = takeIdemKey() || newIdemKey();
    rememberIdemKey(idem);
    const payload = buildPayload(); // já inclui IDEMP_KEY (se existir)
    collectFase4IntoPayload(payload); 

    // ===== GARANTIA FINAL DE TIPO PARA A API =====
    if (Array.isArray(payload.F43_INCLUIR)) {
      payload.F43_INCLUIR = payload.F43_INCLUIR.join('; ');
    }
    if (Array.isArray(payload.F43_INCLUIR_B)) {
      payload.F43_INCLUIR_B = payload.F43_INCLUIR_B.join('; ');
    }

    if (window.__DEBUG_SOLIC_CRP__) {
      try {
        console.log('[SUBMIT] payload →', JSON.stringify(payload, null, 2));
        console.log('[SUBMIT] campos críticos →', {
          DATA_VENC_ULTIMO_CRP: payload.DATA_VENC_ULTIMO_CRP || payload.DATA_VENCIMENTO_ULTIMO_CRP,
          TIPO_EMISSAO_ULTIMO_CRP: payload.TIPO_EMISSAO_ULTIMO_CRP,
          PRAZO_ADICIONAL_COD: payload.PRAZO_ADICIONAL_COD,
          PRAZO_ADICIONAL_TEXTO: payload.PRAZO_ADICIONAL_TEXTO,
          FASE_PROGRAMA: payload.FASE_PROGRAMA
        });
      } catch {}
    }

    const btn = el.btnSubmit;
    const old = btn?.innerHTML ?? '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Finalizando…'; }

    let t = setTimeout(()=> {
      try { bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).show(); } catch {}
    }, 3000);

    try {
      await waitForService({ timeoutMs: 60000, pollMs: 1500 });




      const resp = await postJSON(
        api('/gerar-solic-crp'),
        payload,
        withKey({ 'X-Idempotency-Key': idem })
      );

      if (window.__DEBUG_SOLIC_CRP__) {
        try { console.log('[SUBMIT] resposta API →', resp); } catch {}
      }

      clearTimeout(t);
      try { bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); } catch {}
      clearIdemKey();
      if (btn) btn.innerHTML = 'Finalizado ✓';

      setTimeout(()=>{
        try { form.reset(); } catch {}
        clearAllState();

        // limpa e reseta campos auxiliares do passo 0
        if (el.hasGescon) el.hasGescon.value = '0';
        if (el.cnpjInput) el.cnpjInput.value = '';
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

        if (btn) { btn.disabled = false; btn.innerHTML = old; }

        curStep = 0;
        window.__renderStepper?.();
      }, 800);

    } catch (err) {
      clearTimeout(t);
      try { bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); } catch {}

      dbe('[SUBMIT][ERRO]', err);
      try {
        console.error('[SUBMIT][ERRO detalhe]', {
          message: err?.message,
          status: err?.status || err?.response?.status,
          data: err?.response?.data
        });
      } catch {}

      showErro(friendlyErrorMessages(err, 'Falha ao registrar a solicitação.'));

      if (btn) { btn.disabled = false; btn.innerHTML = old || 'Finalizar'; }
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
    if ($data)   $data.textContent   = toDateBR(reg?.data_encaminhamento || '') || '—';
    if ($sei)    $sei.textContent    = reg?.processo_sei || '—';

    // Espelha também no intro (quando existir)
    if (el.introNGescon) el.introNGescon.textContent = reg?.gescon_consulta || '—';
    if (el.introDataEnc) el.introDataEnc.textContent = toDateBR(reg?.data_encaminhamento || '') || '—';
    if (el.introProcSei) el.introProcSei.textContent = reg?.processo_sei || '—';
  }

  /* ========= Bootstrap geral na carga ========= */
  function initAll(){
    bindMasks();
    bindSyncUg132();
    ensureStepperFallback();
    setupFase4Toggles();

    bindCondicionais();

    // Botão pesquisar
    el.btnPesquisar?.addEventListener('click', onPesquisar);

    // Garantir botões "Voltar" nos modais das fases
    ['modalF41','modalF42','modalF43','modalF44','modalF45','modalF46','modalGesconNaoEncontrado','modalAtencao','modalErro','modalSucesso','modalGerandoPdf','modalSalvando']
      .forEach(ensureBackButton);

    // Bem-vindo
    initWelcome();

    // Reidrata estado
    loadState();
    // Popular listas Fase 4 (caso chegue já no passo avançado)
    popularListasFaseComBaseNosCritérios();

    // Dispara um evento para templates data-k ouvirem
    try { document.dispatchEvent(new Event('TERMO_READY')); } catch {}
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once:true });
  } else {
    initAll();
  }

})(); 
