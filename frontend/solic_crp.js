// solic_crp.js — fluxo completo da Solicitação de CRP Emergencial (isolado da Adesão)
(() => {
  // === DEBUG global (ligue/desligue quando quiser) ===
  window.__DEBUG_SOLIC_CRP__ = true;
  function dbg(...args){ if (window.__DEBUG_SOLIC_CRP__) console.log(...args); }
  function dbe(...args){ if (window.__DEBUG_SOLIC_CRP__) console.error(...args); }

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
    data.values['CRITERIOS_IRREGULARES[]'] = $$('.form-check-input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i=>i.value);

    // fase selecionada (radio)
    const faseSel = $('input[name="FASE_PROGRAMA"]:checked');
    data.values['FASE_PROGRAMA'] = faseSel?.value || '';

    // 4.1
    const f41 = $('input[name="F41_OPCAO"]:checked'); data.values['F41_OPCAO'] = f41?.value||'';

    // 4.2
    data.values['F42_LISTA[]'] = $$("#F42_LISTA input[type=\"checkbox\"]:checked").map(i=>i.value);

    // 4.3
    data.values['F43_LISTA[]'] = $$("#F43_LISTA input[type=\"checkbox\"]:checked").map(i=>i.value);
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
    data.values['F44_CRITERIOS[]']   = $$("#F44_CRITERIOS input[type=\"checkbox\"]:checked").map(i=>i.value);
    data.values['F44_DECLS[]']       = $$("#blk_44 .d-flex input[type=\"checkbox\"]:checked").map(i=>i.value);
    data.values['F44_FINALIDADES[]'] = $$("#F44_FINALIDADES input[type=\"checkbox\"]:checked").map(i=>i.value);
    data.values['F44_ANEXOS']        = $('#F44_ANEXOS')?.value || '';
    data.values['F441_OPTD']        = !!$('#F441_OPTD')?.checked;
    data.values['F441_LEGISLACAO']  = $('#F441_LEGISLACAO')?.value || '';
    data.values['F445_DESC_PLANOS'] = $('#F445_DESC_PLANOS')?.value || '';
    data.values['F446_DOCS']        = $('#F446_DOCS')?.value || '';
    data.values['F446_EXEC_RES']    = $('#F446_EXEC_RES')?.value || '';
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
  data.values['F46_FINALIDADES[]'] = $$("#F46_FINALIDADES input[type=\"checkbox\"]:checked").map(i=>i.value);

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
        if (/municipal/i.test(esfera)) { if (el.esfMun) el.esfMun.checked = true; }
        if (/estadual|distrital/i.test(esfera)) { if (el.esfEst) el.esfEst.checked = true; }
      }
      // 3.1/3.2 — replicar em infos de leitura se existirem
      try{
        const infoVenc = document.getElementById('infoDataVencUltimoCrp');
        const infoTipo = document.getElementById('infoTipoEmissaoUltimoCrp');
        const vencBR = toDateBR(el.dataUltCrp?.value || '');
        if (infoVenc) infoVenc.textContent = vencBR || '—';
        const t = (el.selectTipoUltCrp?.value || (el.tipoAdm?.checked ? 'Administrativa' : (el.tipoJud?.checked ? 'Judicial' : '')) || '').trim();
        if (infoTipo) infoTipo.textContent = t || '—';
      }catch{}

      saveState();
      return true;
    }catch(err){
      dbe('[hidratarTermosRegistrados] erro:', err);
      return false;
    }
  }

  function preencherRegistrosDoTermo(patch){
    try{
      const map = {
        'infoNumGescon' : 'gescon_consulta',
        'infoDataEncGescon' : 'data_encaminhamento',
        'INFO_PROC_SEI' : 'processo_sei'
      };
      Object.entries(map).forEach(([id, key])=>{
        const e = document.getElementById(id);
        if (e && patch[key] != null) e.textContent = String(patch[key] || '—');
      });
    }catch{}
  }

  /* ========= Helpers UI ========= */
  function showModal(id){
    const m = document.getElementById(id);
    if (!m) return;
    try { new bootstrap.Modal(m).show(); } catch { m.classList.add('show'); m.style.display='block'; }
  }
  function showErro(msgs){
    const list = $('#modalErroLista'); if(list){ list.innerHTML = msgs.map(m=>`<li>${m}</li>`).join(''); }
    showModal('modalErro');
  }

  function validarFaseSelecionada(){
    const sel = document.querySelector('input[name="FASE_PROGRAMA"]:checked');
    if (!sel) return { ok:false, motivo: 'Selecione uma finalidade (4.x) antes de avançar.' };
    return { ok:true };
  }

  /* ========= Submissão (salvar e gerar PDF) ========= */
  async function montarPayloadFinal(){
    const form = document.getElementById('formSolicCrp');
    const payload = serializeFormToPayload(form);
    ensureDefaultsForPayload(payload);

    // Normaliza alguns campos que têm aliases no template
    if (!payload.DATA_VENC_ULTIMO_CRP && payload.DATA_VENCIMENTO_ULTIMO_CRP) {
      payload.DATA_VENC_ULTIMO_CRP = payload.DATA_VENCIMENTO_ULTIMO_CRP;
    }

    // CNPJ UG (sem máscara)
    const cnpjUgNum = obterCNPJUG();
    if (cnpjUgNum) payload.CNPJ_UG_NUM = cnpjUgNum;

    // Carimbos
    const now = new Date();
    payload.MES = String(now.getMonth()+1).padStart(2,'0');
    payload.ANO_SOLIC_GERADA = String(now.getFullYear());
    payload.HORA_SOLIC_GERADA = fmtHR(now);

    // Esfera
    payload.ESFERA_MUNICIPAL = document.getElementById('esf_mun')?.checked ? 'SIM' : '';
    payload.ESFERA_ESTADUAL  = document.getElementById('esf_est')?.checked ? 'SIM' : '';

    return payload;
  }

  async function salvarDados(){
    const payload = await montarPayloadFinal();
    const idem = takeIdemKey() || newIdemKey();
    rememberIdemKey(idem);

    try{
      showModal('modalSalvando');
      await postJSON(api('/solic-crp/salvar'), { idem, payload }, withKey());
      clearIdemKey();
      document.getElementById('modalSalvando')?.addEventListener('hidden.bs.modal', ()=>{
        showModal('modalSucesso');
      }, { once:true });
      const m = bootstrap.Modal.getInstance(document.getElementById('modalSalvando'));
      m?.hide();
    }catch(err){
      showErro(friendlyErrorMessages(err));
    }
  }

  async function gerarPdf(){
    const payload = await montarPayloadFinal();
    try{
      showModal('modalGerandoPdf');
      const blob = await fetchBinary(api('/solic-crp/pdf'), {
        method: 'POST',
        headers: withKey({'Content-Type':'application/json'}),
        body: JSON.stringify(payload)
      }, { label:'pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Solicitacao_CRP_${(payload.ENTE||'ente').replace(/\\s+/g,'_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=> URL.revokeObjectURL(url), 1500);
      const m = bootstrap.Modal.getInstance(document.getElementById('modalGerandoPdf'));
      m?.hide();
    }catch(err){
      showErro(friendlyErrorMessages(err));
    }
  }

  /* ========= Init ========= */
  function init(){
    bindMasks();
    bindSyncUg132();
    ensureStepperFallback();

    // Botões principais
    el.btnPesquisar?.addEventListener('click', onPesquisar);
    el.btnSubmit?.addEventListener('click', (e)=>{ e.preventDefault(); salvarDados(); });
    el.btnGerar?.addEventListener('click', (e)=>{ e.preventDefault(); gerarPdf(); });

    // Monta botões "Voltar" nos modais da fase 4 (se existirem)
    ['modalFase41','modalFase42','modalFase43','modalFase44','modalFase45','modalFase46'].forEach(ensureBackButton);

    // Hidrata estado salvo (se houver) e renderiza passo
    loadState();
    window.__renderStepper?.();
  }

  document.addEventListener('DOMContentLoaded', init);
  // Exponha algumas funções úteis (debug)
  window.__SOLICCRP__ = {
    toDateBR, toISOForInput, serializeFormToPayload,
    montarPayloadFinal, salvarDados, gerarPdf,
    consultarGesconByCnpj, consultarTermosRegistrados
  };
})();
