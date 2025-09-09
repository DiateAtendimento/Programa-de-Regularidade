//script.js
(() => {
  
  /* ========= Config ========= */
  const API_BASE = 'https://programa-de-regularidade.onrender.com';

  // Limpeza automática de rascunhos não finalizados ao abrir a página
  const AUTO_CLEAR_DRAFTS = false;                 // mude para false se quiser permitir retomar rascunho
  const FORM_TTL_MS = 30 * 60 * 1000;             // 30 min de validade do rascunho

  /* ========= Idempotência (frontend) ========= */
  const IDEM_STORE_KEY = 'rpps-idem-submit';

  function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  function newIdemKey() {
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return 'id_' + hex(a);
    } catch {
      return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  function rememberIdemKey(key) {
    try { localStorage.setItem(IDEM_STORE_KEY, JSON.stringify({ key, ts: Date.now() })); } catch {}
  }
  function takeIdemKey() {
    try {
      const raw = localStorage.getItem(IDEM_STORE_KEY);
      if (!raw) return null;
      const { key } = JSON.parse(raw);
      return key || null;
    } catch { return null; }
  }
  function clearIdemKey() { try { localStorage.removeItem(IDEM_STORE_KEY); } catch {} }

  /* ========= Robustez de rede ========= */
  const FETCH_TIMEOUT_MS = 120000; 
  const FETCH_RETRIES = 1;        // tentativas além da primeira

  // drop-in replacement
  async function fetchJSON(
    url,
    { method = 'GET', headers = {}, body = null } = {},
    { label = 'request', timeout = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}
  ) {
    let attempt = 0;
    let didWait = false;

    // cache-busting por querystring
    const bust = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sep = url.includes('?') ? '&' : '?';
    const finalURL = `${url}${sep}${bust}`;
    const finalHeaders = { ...headers };

    while (true) {
      attempt++;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(`timeout:${label}`), timeout);

      try {
        const res = await fetch(finalURL, {
          method,
          headers: finalHeaders,
          body,
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'follow',
          mode: 'cors'
        });
        clearTimeout(to);

        if (!res.ok) {
          const isJson = (res.headers.get('content-type') || '').includes('application/json');
          const data = isJson ? (await res.json().catch(() => null)) : null;
          const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }

        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();

      } catch (e) {
        clearTimeout(to);
        const m = String(e?.message || '').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');

        const retriable =
          (isHttp && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || e.status >= 500)) ||
          m.includes('etimedout') || m.includes('timeout:') || m.includes('abort') ||
          m.includes('econnreset') || m.includes('socket hang up') || m.includes('eai_again') ||
          m.includes('bad gateway') || m.includes('failed to fetch') || m.includes('typeerror: failed to fetch') ||
          m.includes('cors') || (!navigator.onLine);

        // tentativas rápidas com backoff exponencial
        if (retriable && attempt <= (retries + 1)) {
          const backoff = Math.min(4000, 300 * Math.pow(2, attempt - 1));
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        // último recurso: aguarda o serviço responder /api/health e tenta 1x
        if (retriable && !didWait) {
          didWait = true;
          const ok = await waitForService({ timeoutMs: 60_000, pollMs: 2500 });
          if (ok) continue;
        }

        throw e;
      }
    }
  }

  // === NOVO: fetchBinary (Blob) com timeout + retries (mesma política do fetchJSON) ===
  async function fetchBinary(
    url,
    { method = 'GET', headers = {}, body = null } = {},
    { label = 'binary', timeout = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}
  ) {
    let attempt = 0;

    const bust = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sep = url.includes('?') ? '&' : '?';
    const finalURL = `${url}${sep}${bust}`;

    while (true) {
      attempt++;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(`timeout:${label}`), timeout);
      try {
        const res = await fetch(finalURL, {
          method,
          headers,
          body,
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'follow',
          mode: 'cors'
        });
        clearTimeout(to);

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return await res.blob();
      } catch (e) {
        clearTimeout(to);
        const m = String(e?.message || '').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');
        const retriable =
          (isHttp && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || e.status >= 500)) ||
          m.includes('etimedout') || m.includes('timeout:') || m.includes('abort') ||
          m.includes('econnreset') || m.includes('socket hang up') || m.includes('eai_again') ||
          (!navigator.onLine) ||
          m.includes('failed') || m.includes('bad gateway');

        if (!retriable || attempt > (retries + 1)) throw e;

        const backoff = 300 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }


  async function waitForService({ timeoutMs = 60_000, pollMs = 2000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await fetchJSON(`${API_BASE}/api/health`, {}, { label: 'health', timeout: 4000, retries: 0 });
        if (r && r.ok) return true;
      } catch (_) {}
      await new Promise(r => setTimeout(r, pollMs));
    }
    return false;
  }

  function friendlyErrorMessages(err, fallback='Falha ao comunicar com o servidor.') {
    const status = err?.status;
    const msg = String(err?.message || '').toLowerCase();

    if (!navigator.onLine) return ['Sem conexão com a internet. Verifique sua rede e tente novamente.'];
    if (status === 504 || msg.includes('timeout:')) return ['Tempo de resposta esgotado. Tente novamente em instantes.'];
    if (status === 502 || msg.includes('bad gateway')) return ['Servidor reiniciando. Tente novamente em alguns segundos.'];
    if (status === 429 || msg.includes('rate limit')) return ['Muitas solicitações no momento. Aguarde alguns segundos e tente novamente.'];
    if (status === 404) return ['Registro não encontrado. Verifique os dados informados.'];
    if (status && status >= 500) return ['Instabilidade no servidor. Tente novamente em instantes.'];
    return [fallback];
  }

  /* ========= Helpers ========= */
  const $  = (s, r=document)=> r.querySelector(s);
  const $$ = (s, r=document)=> Array.from(r.querySelectorAll(s));
  const digits = v => String(v||'').replace(/\D+/g,'');
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fmtBR = d => d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const fmtHR = d => d.toLocaleTimeString('pt-BR',{hour12:false,timeZone:'America/Sao_Paulo'});
  const rmAcc = s => String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();


  /* ========= Replicação imediata de e-mails (colunas F/G da aba CNPJ_ENTE_UG) ========= */
  function debounce(fn, wait=800) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  async function forceReplicateEmails(reason = 'edit') {
    try {
      const cnpjEnte = digits($('#CNPJ_ENTE')?.value || '');
      const cnpjUg   = digits($('#CNPJ_UG')?.value || '');

      // e-mails diretos
      const emailEnte    = ($('#EMAIL_ENTE')?.value || '').trim();
      const emailUg      = ($('#EMAIL_UG')?.value || '').trim();
      // fallbacks (representantes)
      const emailRepEnte = ($('#EMAIL_REP_ENTE')?.value || '').trim();
      const emailRepUg   = ($('#EMAIL_REP_UG')?.value || '').trim();

      // escolhe: valor direto se válido, senão usa o do representante (se válido)
      const finalEmailEnte = isEmail(emailEnte) ? emailEnte : (isEmail(emailRepEnte) ? emailRepEnte : '');
      const finalEmailUg   = isEmail(emailUg)   ? emailUg   : (isEmail(emailRepUg)   ? emailRepUg   : '');

      // precisa ter pelo menos 1 CNPJ válido e 1 e-mail válido (direto ou fallback)
      const hasCnpj  = (cnpjEnte.length === 14) || (cnpjUg.length === 14);
      const hasEmail = !!finalEmailEnte || !!finalEmailUg;
      if (!hasCnpj || !hasEmail) return;

      const body = {
        UF:         ($('#UF')?.value || '').trim(),
        ENTE:       ($('#ENTE')?.value || '').trim(),
        UG:         ($('#UG')?.value || '').trim(),
        CNPJ_ENTE:  cnpjEnte,
        CNPJ_UG:    cnpjUg,
        EMAIL_ENTE: finalEmailEnte,
        EMAIL_UG:   finalEmailUg,
        __source:   `frontend-email-sync:${reason}`
      };

      // silencioso: sem modal/loader para não travar a UI
      fetchJSON(
        `${API_BASE}/api/upsert-cnpj`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) },
        { label:'upsert-cnpj(email-sync)', timeout: 8000, retries: 1 }
      ).catch(() => { /* silencioso */ });
    } catch (_) { /* noop */ }
  }


  const replicateEmails = debounce(forceReplicateEmails, 800);

  // Dispara replicação ao digitar e ao sair do campo
  ['EMAIL_ENTE','EMAIL_UG','EMAIL_REP_ENTE','EMAIL_REP_UG'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => replicateEmails('input'));
    el.addEventListener('blur',  () => replicateEmails('blur'));
  });



  // Modais
  const modalErro     = new bootstrap.Modal($('#modalErro'));
  const modalSucesso  = new bootstrap.Modal($('#modalSucesso'));
  const modalWelcome  = new bootstrap.Modal($('#modalWelcome'));
  const modalLoadingSearch = new bootstrap.Modal($('#modalLoadingSearch'), { backdrop:'static', keyboard:false });
  const modalGerandoPdf = new bootstrap.Modal($('#modalGerandoPdf'), { backdrop:'static', keyboard:false });
  const modalSalvando = new bootstrap.Modal($('#modalSalvando'), { backdrop:'static', keyboard:false });

  /* ========= Persistência (etapa + campos) ========= */
  const STORAGE_KEY = 'rpps-form-v1';

  // flag de "bem-vindo" por ABA (sobrevive a refresh, zera ao fechar a aba)
  const WELCOME_SESSION_KEY = 'rpps-welcome-seen:session';
  function hasSeenWelcomeSession(){ try { return sessionStorage.getItem(WELCOME_SESSION_KEY) === '1'; } catch { return false; } }
  function rememberWelcomeSession(){ try { sessionStorage.setItem(WELCOME_SESSION_KEY, '1'); } catch {} }

  // (limpa legado persistente, opcional)
  try { localStorage.removeItem('rpps-welcome-seen'); } catch {}



  function clearAllState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    clearIdemKey();
  }

  function getState(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }
  function setState(updater){
    const prev = getState() || { step: 0, values: {}, seenWelcome: false, lastSaved: 0, finalizedAt: 0 };
    const next = (typeof updater === 'function') ? updater(prev) : { ...prev, ...updater };
    next.lastSaved = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }
  function markWelcomeSeen(){ setState(s => ({ ...s, seenWelcome: true })); }

  function saveState() {
    const prev = getState();
    const data = {
      step,
      values: {},
      seenWelcome: prev?.seenWelcome ?? false,
      lastSaved: Date.now(),
      finalizedAt: prev?.finalizedAt || 0
    };
    [
      'UF','ENTE','CNPJ_ENTE','EMAIL_ENTE','UG','CNPJ_UG','EMAIL_UG',
      'CPF_REP_ENTE','NOME_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE',
      'CPF_REP_UG','NOME_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG',
      'DATA_VENCIMENTO_ULTIMO_CRP'
    ].forEach(id => { const el = document.getElementById(id); if (el) data.values[id] = el.value; });

    data.values['em_adm'] = !!document.getElementById('em_adm')?.checked;
    data.values['em_jud'] = !!document.getElementById('em_jud')?.checked;

    ['CRITERIOS_IRREGULARES[]','COMPROMISSOS[]','PROVIDENCIAS[]','FINALIDADES[]','CONDICOES[]']
      .forEach(name => {
        data.values[name] = $$(`input[name="${name}"]:checked`).map(i => i.value);
    });

      // ✅ checkboxes “soltos” (1.1, 4.x e 7)
    [
      'esf_mun','esf_est',
      'fin_parc','fin_reg',
      'parc60','parc300',
      'reg_sem_jud','reg_com_jud',
      'eq_implano','eq_prazos','eq_plano_alt',
      'org_ugu','org_outros',
      'man_cert','man_melhoria','man_acomp',
      'DECL_CIENCIA'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) data.values[id] = !!el.checked;
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const st = JSON.parse(raw);
      const vals = st?.values || {};

      // 1) Restaurar arrays (ex.: ESFERA_GOVERNO[], CRITERIOS_IRREGULARES[])
      Object.entries(vals).forEach(([k, v]) => {
        if (k.endsWith('[]')) {
          $$(`input[name="${k}"]`).forEach(i => {
            i.checked = Array.isArray(v) && v.includes(i.value);
          });
        }
      });

      // 2) Restaurar inputs “simples”
      Object.entries(vals).forEach(([k, v]) => {
        if (k.endsWith('[]')) return; // já feito acima
        const el = document.getElementById(k);
        if (!el) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = !!v;
        } else {
          el.value = v ?? '';
        }
      });

      return st;
    } catch { return null; }
  }


  // --- Controle robusto do modal de "carregando" + Lottie ---
  let loadingCount = 0;

  function killBackdropLocks() {
    // Não feche modais visíveis; apenas limpe travas se não houver nenhuma aberta
    defocusIfInsideModal();
    setTimeout(() => {
      const hasOpen = !!document.querySelector('.modal.show');
      if (!hasOpen) {
        document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('padding-right');
      }
    }, 0);
  }


  function unlockUI() {
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('padding-right');
  }

  function showLoadingModal() {
    try { modalLoadingSearch.show(); } catch {}
  }
  function startLoading() {
    loadingCount += 1;
    if (loadingCount === 1) showLoadingModal();
  }
  function stopLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
      try { modalLoadingSearch.hide(); } catch {}
      setTimeout(() => {
        const el = $('#modalLoadingSearch');
        el?.classList.remove('show');
        document.body.classList.remove('modal-open');
        $$('.modal-backdrop')?.forEach(b => b.remove());
        const inst = lotties['lottieLoadingSearch'];
        if (inst) { inst.destroy(); delete lotties['lottieLoadingSearch']; }
      }, 60);
    }
  }
  function forceCloseLoading() { loadingCount = 0; stopLoading(); }

  $('#modalLoadingSearch')?.addEventListener('hidden.bs.modal', () => {
    const inst = lotties['lottieLoadingSearch'];
    if (inst) { inst.destroy(); delete lotties['lottieLoadingSearch']; }
    killBackdropLocks();
  });

  function safeShowModal(modalInstance){
    forceCloseLoading();      // fecha “Carregando…”, se estiver aberto
    defocusIfInsideModal();
    setTimeout(() => {
      try { modalInstance.show(); } catch {}
      // Limpa backdrops órfãos apenas se não houver outra modal aberta
      killBackdropLocks();
    }, 0);
  }


  /* ========= Lottie ========= */
  const lotties = {};
  function mountLottie(id, jsonPath, {loop=true, autoplay=true, renderer='svg'}={}) {
    const el = document.getElementById(id);
    if (!el) return;
    if (lotties[id]) { lotties[id].destroy(); delete lotties[id]; }
    lotties[id] = lottie.loadAnimation({ container: el, path: jsonPath, loop, autoplay, renderer });
  }

  $('#modalLoadingSearch')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieLoadingSearch', 'animacao/carregando-info.json', { loop:true, autoplay:true });
  });
  $('#modalSucesso')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieSuccess', 'animacao/confirm-success.json', { loop:false, autoplay:true });
  });
  $('#modalGerandoPdf')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieGerandoPdf', 'animacao/gerando-pdf.json', { loop:true, autoplay:true });
  });
  $('#modalSalvando')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieSalvando', 'animacao/gerando-pdf.json', { loop:true, autoplay:true });
  });
  $('#modalSalvando')?.addEventListener('hidden.bs.modal', () => {
    const inst = lotties['lottieSalvando'];
    if (inst) { inst.destroy(); delete lotties['lottieSalvando']; }
    killBackdropLocks(); // garante que não fique backdrop travado
  });

  // Destrava tudo (modais/backdrop/body/loader)
  function fullUnlock() {
    try { modalWelcome.hide(); } catch {}
    try { modalLoadingSearch.hide(); } catch {}
    try { modalGerandoPdf.hide(); } catch {}
    forceCloseLoading();
    killBackdropLocks();
    unlockUI();
  }

  // === A11y/foco: evita 'aria-hidden' com foco dentro de modal e cliques perdidos ===
  function defocusIfInsideModal() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('.modal')) {
      try { ae.blur(); } catch {}
      try {
        document.body.setAttribute('tabindex', '-1');
        document.body.focus({ preventScroll: true });
      } catch {}
      try { document.body.removeAttribute('tabindex'); } catch {}
    }
  }

  // Garanta foco limpo quando qualquer modal vai/foi escondido
  document.addEventListener('hide.bs.modal',   defocusIfInsideModal, true);
  document.addEventListener('hidden.bs.modal', defocusIfInsideModal, true);

  function closeSavingModal(timer){
    clearTimeout(timer);
    try { modalSalvando.hide(); } catch {}
  }

  function setErroHeader(mode){
    const header = $('#modalErro .modal-header');
    const title  = $('#modalErro .modal-title');
    if (!header || !title) return;
    if (mode === 'atencao'){
      header.classList.remove('bg-danger','text-white');
      header.classList.add('bg-warning');
      title.textContent = 'Atenção';
      mountLottie('lottieError', 'animacao/atencao-info.json', { loop:false, autoplay:true });
    }else{
      header.classList.remove('bg-warning');
      header.classList.add('bg-danger','text-white');
      title.textContent = 'Erro';
      mountLottie('lottieError', 'animacao/confirm-error.json', { loop:false, autoplay:true });
    }
  }
  function showAtencao(msgs){
    const ul = $('#modalErroLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
    setErroHeader('atencao');
    safeShowModal(modalErro);
  }
  function showErro(msgs){
    const ul = $('#modalErroLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
    setErroHeader('erro');
    safeShowModal(modalErro);
  }

  /* ========= DOMContentLoaded ========= */
  document.addEventListener('DOMContentLoaded', () => {
    fullUnlock();

    /* 
    
    Limpa rascunhos não finalizados/expirados ao abrir
    const st = getState();
    const now = Date.now();
    const isExpired = !!st?.lastSaved && (now - st.lastSaved > FORM_TTL_MS);
    const notFinalized = !st?.finalizedAt;

    if (AUTO_CLEAR_DRAFTS && (st && (isExpired || notFinalized))) {
      clearAllState();
    }
    
    */

    const alreadySeen = hasSeenWelcomeSession();
    if (!alreadySeen) {
      // marca antes de abrir para sobreviver a F5
      rememberWelcomeSession();
      setTimeout(() => { try { modalWelcome.show(); } catch {} }, 0);
    }

    
    fetchJSON(`${API_BASE}/api/warmup`, {}, { label: 'warmup', timeout: 15000, retries: 0 }).catch(()=>{});

    // pré-aquecer o backend (evita o 1º 502 na primeira ação do usuário)
    waitForService({ timeoutMs: 15000, pollMs: 1500 }).catch(()=>{});
 
    // salvar sempre que o usuário muda algo (sem travar a UI)
    const formEl = document.getElementById('regularidadeForm');
    if (formEl) {
      const saveStateDebounced = debounce(saveState, 400);
      formEl.addEventListener('input', saveStateDebounced);
      formEl.addEventListener('change', saveStateDebounced);
    }

  });
  window.addEventListener('beforeunload', saveState);

  /* ========= Máscaras ========= */
  const maskCPF = v => {
    const d = digits(v).slice(0,11);
    let o = d;
    if (d.length>3)  o = d.slice(0,3)+'.'+d.slice(3);
    if (d.length>6)  o = o.slice(0,7)+'.'+o.slice(7);
    if (d.length>9)  o = o.slice(0,11)+'-'+o.slice(11);
    return o;
  };
  const maskCNPJ = v => {
    const d = digits(v).slice(0,14);
    let o = d;
    if (d.length>2)  o = d.slice(0,2)+'.'+d.slice(2);
    if (d.length>5)  o = o.slice(0,6)+'.'+o.slice(6);
    if (d.length>8)  o = o.slice(0,10)+'/'+o.slice(10);
    if (d.length>12) o = o.slice(0,15)+'-'+o.slice(15);
    return o;
  };
  function applyMask(id, kind){
    const el = document.getElementById(id); if(!el) return;
    const need = kind==='cpf'?11:14;
    el.setAttribute('maxlength', kind==='cpf'?'14':'18');
    const fmt = kind==='cpf'?maskCPF:maskCNPJ;
    el.addEventListener('input', ()=> el.value = fmt(el.value));
    el.addEventListener('blur', ()=>{
      const ok = digits(el.value).length===need || (!el.value && kind==='cpf');
      el.classList.toggle('is-valid', ok && !!el.value);
      el.classList.toggle('is-invalid', !ok && !!el.value);
    });
  }
  ['CNPJ_ENTE_PESQ','CNPJ_ENTE','CNPJ_UG'].forEach(id=>applyMask(id,'cnpj'));
  ['CPF_REP_ENTE','CPF_REP_UG'].forEach(id=>applyMask(id,'cpf'));

  function maskPhone(v){
    const d = digits(v).slice(0,11);
    if(d.length<=10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/,'($1) $2-$3').trim();
    return d.replace(/(\d{2})(\d{5})(\d{0,4})/,'($1) $2-$3').trim();
  }
  ;['TEL_REP_ENTE','TEL_REP_UG'].forEach(id=>{
    const el = document.getElementById(id); if(!el) return;
    el.addEventListener('input', ()=> el.value = maskPhone(el.value));
  });

  const markValid   = el => { el.classList.add('is-valid'); el.classList.remove('is-invalid'); };
  const markInvalid = el => { el.classList.add('is-invalid'); el.classList.remove('is-valid'); };
  const neutral     = el => el.classList.remove('is-valid','is-invalid');

  function paintLabelForInput(input, invalid){
    if (!input) return;
    const label = input.closest('.form-check')?.querySelector('label')
               || input.parentElement?.querySelector('label')
               || document.querySelector(`label[for="${input.id}"]`);
    input.classList.toggle('is-invalid', invalid);
    if (label) label.classList.toggle('invalid', invalid);
  }
  function paintGroupLabels(selectors, invalid){
    selectors.forEach(sel => paintLabelForInput(document.querySelector(sel), invalid));
  }

  function clearValidationIn(stepNumber){
    const sec = [...document.querySelectorAll('#regularidadeForm [data-step]')]
      .find(s => Number(s.dataset.step) === stepNumber);
    if (!sec) return;
    sec.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    sec.querySelectorAll('label.invalid').forEach(el => el.classList.remove('invalid'));
  }

  // Modal de confirmação (genérico para CNPJ/CPF)
  const modalConfirmAdd = new bootstrap.Modal($('#modalConfirmAdd'));
  const elConfirmTitle  = $('#modalConfirmAddTitle');
  const elConfirmMsg    = $('#modalConfirmAddMsg');
  const btnConfirmYes   = $('#btnConfirmAddYes');

  function openConfirmAdd({ type, value, onYes }) {
    const isCnpj = (type === 'cnpj');
    elConfirmTitle.textContent = isCnpj ? 'CNPJ não encontrado' : 'CPF não encontrado';

    const fmt = isCnpj ? maskCNPJ(value) : maskCPF(value);
    elConfirmMsg.innerHTML = `
      Não encontramos esse ${isCnpj ? 'CNPJ' : 'CPF'} em nosso banco de dados.<br>
      Você poderia verificar se os dados estão corretos? <strong>${fmt}</strong>.<br><br>
      Caso deseje prosseguir mesmo assim, podemos adicioná-lo e continuar com o preenchimento das informações.
    `;

    btnConfirmYes.onclick = () => { try { onYes?.(); } finally { modalConfirmAdd.hide(); killBackdropLocks(); } };
    safeShowModal(modalConfirmAdd);
  }

  /* ========= Stepper / Navegação ========= */
  let step = 0;   // 0..8
  let cnpjOK = false;

  const sections = $$('#regularidadeForm [data-step]');
  const stepsUI  = $$('#stepper .step');
  const btnPrev  = $('#btnPrev');
  const btnNext  = $('#btnNext');
  const btnSubmit= $('#btnSubmit');
  const btnGerar = $('#btnGerarForm'); // botão de "Gerar Formulário"
  const navFooter= $('#navFooter');
  const pesquisaRow = $('#pesquisaRow');

  const nextAnchor = document.createComment('next-button-anchor');
  if (navFooter && btnSubmit && navFooter.contains(btnSubmit)) {
    navFooter.insertBefore(nextAnchor, btnSubmit);
  } else if (navFooter) {
    navFooter.appendChild(nextAnchor);
  }

  let inlineNextCol = null;

  function placeNextInline(inline){
    if (!btnNext) return;

    if (inline) {
      if (!inlineNextCol) {
        inlineNextCol = document.createElement('div');
      }
      inlineNextCol.className = 'col-auto ms-auto';
      inlineNextCol.appendChild(btnNext);
      pesquisaRow?.classList.add('flex-nowrap');
      pesquisaRow?.appendChild(inlineNextCol);
    } else {
      navFooter?.insertBefore(btnNext, nextAnchor.nextSibling || btnSubmit);
      if (inlineNextCol && inlineNextCol.parentNode) {
        inlineNextCol.parentNode.removeChild(inlineNextCol);
      }
      inlineNextCol = null;
      pesquisaRow?.classList.remove('flex-nowrap');
    }
  }

  function updateNavButtons(){
    btnPrev?.classList.toggle('d-none', step < 1);
    if (btnNext){
      btnNext.disabled = (step === 0 && !cnpjOK);
      btnNext.classList.toggle('d-none', step === 8);
    }
    btnSubmit?.classList.toggle('d-none', step !== 8);
    btnGerar?.classList.toggle('d-none', step !== 8);
  }

  function updateFooterAlign(){
    if (!navFooter) return;
    [btnPrev, btnNext, btnSubmit, btnGerar].forEach(b => b && b.classList.remove('ms-auto'));
    if (step === 8){
      btnSubmit?.classList.add('ms-auto');
    } else if (step > 0) {
      btnNext?.classList.add('ms-auto');
    }
  }

  function showStep(n){
    fullUnlock();
    step = Math.max(0, Math.min(8, n));

    sections.forEach(sec => {
      sec.style.display = (Number(sec.dataset.step) === step ? '' : 'none');
    });

    const activeIdx = Math.min(step, stepsUI.length - 1);
    stepsUI.forEach((s,i)=> s.classList.toggle('active', i === activeIdx));

    placeNextInline(step === 0);
    navFooter?.classList.toggle('d-none', step === 0);

    updateNavButtons();
    updateFooterAlign();

    clearValidationIn(step);

    saveState();
  }

  document.getElementById('CNPJ_ENTE_PESQ')?.addEventListener('input', () => {
    unlockUI();
    if (step === 0) {
      cnpjOK = false;
      updateNavButtons();
      updateFooterAlign();
    }
  });

  ;['CNPJ_ENTE','CNPJ_UG','CPF_REP_ENTE','CPF_REP_UG'].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', unlockUI);
  });

  btnPrev?.addEventListener('click', ()=> showStep(step-1));

  function hasAnyChecked(sel){ return $$(sel).some(i=>i.checked); }

  function validateStep(s){
    const msgs=[];
    const reqAll = {
      1: [
        {id:'UF', type:'select', label:'UF'},
        {id:'ENTE', type:'text', label:'Ente'},
        {id:'CNPJ_ENTE', type:'cnpj', label:'CNPJ do Ente'},
        {id:'UG', type:'text', label:'UG'},
        {id:'CNPJ_UG', type:'cnpj', label:'CNPJ da UG'}
      ],
      2: [
        {id:'CPF_REP_ENTE', type:'cpf', label:'CPF do Rep. do Ente'},
        {id:'NOME_REP_ENTE', type:'text', label:'Nome do Rep. do Ente'},
        {id:'CARGO_REP_ENTE', type:'text', label:'Cargo do Rep. do Ente'},
        {id:'EMAIL_REP_ENTE', type:'email', label:'E-mail do Rep. do Ente'},
        {id:'CPF_REP_UG', type:'cpf', label:'CPF do Rep. da UG'},
        {id:'NOME_REP_UG', type:'text', label:'Nome do Rep. da UG'},
        {id:'CARGO_REP_UG', type:'text', label:'Cargo do Rep. da UG'},
        {id:'EMAIL_REP_UG', type:'email', label:'E-mail do Rep. da UG'}
      ],
      3: [{id:'DATA_VENCIMENTO_ULTIMO_CRP', type:'date', label:'Data do último CRP'}]
    };
    const checkField = (id,type)=>{
      const el = document.getElementById(id); if(!el) return true;
      const v = el.value||'';
      let ok=false;
      if(type==='text') ok = v.trim().length>0;
      else if(type==='email') ok = !!v && isEmail(v);
      else if(type==='date') ok = !!v.trim();
      else if(type==='select') ok = !!v.trim();
      else if(type==='cpf') ok = digits(v).length===11;
      else if(type==='cnpj') ok = digits(v).length===14;
      ok?markValid(el):markInvalid(el);
      return ok;
    };

    if (s<=3) {
      (reqAll[s]||[]).forEach(o => { if(!checkField(o.id,o.type)) msgs.push(o.label); });
      if (s === 1) {
        const grp = $$('input[name="ESFERA_GOVERNO[]"]');
        let ok = false;

        if (grp.length) {
          ok = grp.some(i => i.checked);
          grp.forEach(i => paintLabelForInput(i, !ok));
        } else {
          const m = $('#esf_mun'), e = $('#esf_est');
          ok = !!(m?.checked || e?.checked);
          [m, e].forEach(i => paintLabelForInput(i, !ok));
        }
        if (!ok) msgs.push('Esfera de Governo');
      }

      if (s===3) {
        const adm = $('#em_adm'), jud = $('#em_jud');
        const rOK = adm?.checked || jud?.checked;
        [adm,jud].forEach(i => paintLabelForInput(i, !rOK));
        if (!rOK) msgs.push('Tipo de emissão do último CRP (item 3.2)');

        const crits = $$('input[name="CRITERIOS_IRREGULARES[]"]');
        const cOK = crits.some(i=>i.checked);
        crits.forEach(i => paintLabelForInput(i, !cOK));
        if (!cOK) msgs.push('Critérios irregulares (item 3.3)');
      }
    }

    if (s === 4) {
      const sec4 = document.querySelector('[data-step="4"]');
      const chks = sec4 ? Array.from(sec4.querySelectorAll('input[type="checkbox"]')) : [];
      const ok = chks.some(i => i.checked);
      chks.forEach(i => paintLabelForInput(i, !ok));
      if (!ok) msgs.push('Marque pelo menos um item na etapa 4.');
    

      const g41 = ['#parc60', '#parc300'];
      const g42 = ['#reg_sem_jud', '#reg_com_jud'];
      const ok41_any = g41.some(sel => $(sel)?.checked);
      const ok42_any = g42.some(sel => $(sel)?.checked);
      paintGroupLabels(g41, !ok41_any && !ok42_any);
      paintGroupLabels(g42, !ok41_any && !ok42_any);
      if (!ok41_any && !ok42_any) {
        msgs.push('Marque ao menos uma finalidade detalhada (4.1 ou 4.2).');
      }

      const g43 = ['#eq_implano', '#eq_prazos', '#eq_plano_alt'];
      const ok43 = g43.some(sel => $(sel)?.checked);
      paintGroupLabels(g43, !ok43);
      if (!ok43) msgs.push('Marque ao menos uma opção no item 4.3 (equacionamento do déficit atuarial).');

      const g44 = ['#org_ugu', '#org_outros'];
      const ok44 = g44.some(sel => $(sel)?.checked);
      paintGroupLabels(g44, !ok44);
      if (!ok44) msgs.push('Marque ao menos uma opção no item 4.4 (critérios estruturantes).');

      const g45 = ['#man_cert', '#man_melhoria', '#man_acomp'];
      const ok45 = g45.some(sel => $(sel)?.checked);
      paintGroupLabels(g45, !ok45);
      if (!ok45) msgs.push('Marque ao menos uma opção no item 4.5 (fase de manutenção da conformidade).');
    }

    if (s===5){
      const all = $$('.grp-comp');
      const checked = all.filter(i=>i.checked);
      const ok = checked.length === all.length;
      all.forEach(i => paintLabelForInput(i, !ok && !i.checked));
      if (!ok) msgs.push('No item 5, marque todas as declarações de compromisso.');
    }

    if (s===6){
      const provs = $$('.grp-prov');
      const ok = provs.some(i=>i.checked);
      provs.forEach(i => paintLabelForInput(i, !ok));
      if (!ok) msgs.push('Marque ao menos uma providência (item 6).');
    }

    if (s === 7) {
      const all = $$('.grp-cond');
      const ok = all.length > 0 && all.every(i => i.checked);
      all.forEach(i => paintLabelForInput(i, !ok && !i.checked));
      if (!ok) msgs.push('Marque os quatro itens do item 7 (7.1 a 7.4).');
    }

    if (msgs.length){ showAtencao(msgs); return false; }
    return true;
  }

/* ========= Navegação: botão Próximo (com trava anticlique duplo) ========= */
  let navBusy = false;
  btnNext?.addEventListener('click', async () => {
    if (navBusy) return;
    navBusy = true;
    try {
      if (step === 0 && !cnpjOK) {
        showAtencao(['Pesquise e selecione um CNPJ válido antes de prosseguir.']);
        return;
      }
      if (!validateStep(step)) return;

      if (step === 1 && cnpjMissing) {
        try { await upsertBaseIfMissing(); } catch (_) {}
      }

      showStep(step + 1);
    } finally {
      // atraso mínimo evita 2 cliques muito próximos em redes lentas
      setTimeout(() => { navBusy = false; }, 200);
    }
  });


  /* ========= Esfera ========= */
  $$('.esf-only-one').forEach(chk=>{
    chk.addEventListener('change', ()=>{
      if(chk.checked){ $$('.esf-only-one').forEach(o=>{ if(o!==chk) o.checked=false; }); markValid(chk); }
      else { neutral(chk); }
    });
  });
  function autoselectEsferaByEnte(ente){
    const estadual = rmAcc(ente).includes('governo do estado');
    const chkEst = $('#esf_est'), chkMun = $('#esf_mun');
    if (chkEst && chkMun) {
      chkEst.checked = estadual; chkMun.checked = !estadual;
      [chkEst,chkMun].forEach(neutral);
      markValid(estadual?chkEst:chkMun);
    }
  }

  const editedFields = new Set();
  const trackIds = [
    // 1.2 / 1.3
    'UF','ENTE','CNPJ_ENTE','EMAIL_ENTE','UG','CNPJ_UG','EMAIL_UG',

    // 1.1 Esfera (dois checkboxes)
    'esf_mun','esf_est',

    // 2. Representantes (ENTE/UG)
    'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
    'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG',

    // 3. CRP
    'DATA_VENCIMENTO_ULTIMO_CRP','em_adm','em_jud',

    // 4. Finalidades (todos os itens)
    'fin_parc','fin_reg',
    'parc60','parc300',
    'reg_sem_jud','reg_com_jud',
    'eq_implano','eq_prazos','eq_plano_alt',
    'org_ugu','org_outros',
    'man_cert','man_melhoria','man_acomp',

    // 5. Compromissos (grupo)
    // (grupo via name=[], mas mantemos um representante pra garantir)
    'grpCOMPROMISSOS',

    // 6. Providências (grupo)
    'grpPROVIDENCIAS',

    // 7. Condições
    'DECL_CIENCIA'
  ];

  trackIds.forEach(id=>{
    const el = $('#'+id); if(!el) return;
    const ev = (el.tagName==='SELECT' || el.type==='date') ? 'change' : 'input';
    el.addEventListener(ev, ()=> editedFields.add(id));
  });

  let snapshotBase = null;
  let cnpjMissing = false;

  async function upsertBaseIfMissing(){
    if (!cnpjMissing) return;
    const body = {
      UF: $('#UF').value.trim(),
      ENTE: $('#ENTE').value.trim(),
      UG: $('#UG').value.trim(),
      CNPJ_ENTE: digits($('#CNPJ_ENTE').value),
      CNPJ_UG: digits($('#CNPJ_UG').value),
      EMAIL_ENTE: $('#EMAIL_ENTE').value.trim(),
      EMAIL_UG: $('#EMAIL_UG').value.trim()
    };
    if (digits(body.CNPJ_ENTE).length===14 || digits(body.CNPJ_UG).length===14){
      fetchJSON(`${API_BASE}/api/upsert-cnpj`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) },
        { timeout: 8000, retries: 0, label: 'upsert-cnpj' }
      ).catch(()=>{});
    }
  }

  /* ========= Busca por CNPJ ========= */
  let searching = false;
  $('#btnPesquisar')?.addEventListener('click', async (ev)=>{
    if (searching) return;

    const cnpj = digits($('#CNPJ_ENTE_PESQ').value||'');
    if (cnpj.length !== 14) {
      const el = $('#CNPJ_ENTE_PESQ'); el.classList.add('is-invalid');
      return showAtencao(['Informe um CNPJ válido.']);
    }

    const current = digits($('#CNPJ_ENTE')?.value || $('#CNPJ_UG')?.value || '');
    if (current && current !== cnpj) {
      clearAllState(); // evita “vazar” dados do rascunho anterior
    }

    const forceNoCache = !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
    const btn = $('#btnPesquisar');

    try{
      searching = true;
      btn?.setAttribute('disabled','disabled');
      startLoading();

      // ✅ NOVO: pré-checagem do serviço para reduzir 502/timeout na 1ª chamada
      await waitForService({ timeoutMs: 60000, pollMs: 1500 });

      let r;
      try {
        const url = `${API_BASE}/api/consulta?cnpj=${cnpj}${forceNoCache ? '&nocache=1' : ''}`;
           r = await fetchJSON(
            url,
            {},
            { label: forceNoCache ? 'consulta-cnpj(nocache)' : 'consulta-cnpj', timeout: 110000, retries: 0 }
        );

      } catch (err1) {
        if (!forceNoCache) {
          r = await fetchJSON(
            `${API_BASE}/api/consulta?cnpj=${cnpj}&nocache=1`,
            {},
            { label: 'consulta-cnpj(retry-nocache)', timeout: 110000, retries: 0 }
          );
        } else {
          throw err1;
        }
      }

      if (r && r.missing) {
        cnpjMissing = true;
        openConfirmAdd({
          type: 'cnpj',
          value: cnpj,
          onYes: () => {
            // limpa rascunho + UI antes de continuar
            clearAllState();
            resetFormUI();
            cnpjMissing = true;
            cnpjOK = true;
            $('#CNPJ_ENTE').value = maskCNPJ(cnpj); // ✅ só agora
            showStep(1);
            updateNavButtons();
            updateFooterAlign();
            $('#UF')?.focus();
          }
        });
        return;
      }

      const data = r.data;
      cnpjMissing = !!r.missing;

      snapshotBase = {
        UF: data.UF, ENTE: data.ENTE, CNPJ_ENTE: data.CNPJ_ENTE, UG: data.UG, CNPJ_UG: data.CNPJ_UG,
        NOME_REP_ENTE: data.__snapshot?.NOME_REP_ENTE || '',
        CPF_REP_ENTE:  data.__snapshot?.CPF_REP_ENTE  || '',
        TEL_REP_ENTE:  data.__snapshot?.TEL_REP_ENTE  || '',
        EMAIL_REP_ENTE:data.__snapshot?.EMAIL_REP_ENTE|| '',
        CARGO_REP_ENTE:data.__snapshot?.CARGO_REP_ENTE|| '',
        NOME_REP_UG:   data.__snapshot?.NOME_REP_UG   || '',
        CPF_REP_UG:    data.__snapshot?.CPF_REP_UG    || '',
        TEL_REP_UG:    data.__snapshot?.TEL_REP_UG    || '',
        EMAIL_REP_UG:  data.__snapshot?.EMAIL_REP_UG  || '',
        CARGO_REP_UG:  data.__snapshot?.CARGO_REP_UG  || '',
        DATA_VENCIMENTO_ULTIMO_CRP: data.CRP_DATA_VALIDADE_ISO || data.CRP_DATA_VALIDADE_DMY || ''
      };

      $('#UF').value = data.UF || '';
      $('#ENTE').value = data.ENTE || '';
      $('#CNPJ_ENTE').value = (data.CNPJ_ENTE ? data.CNPJ_ENTE.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5') : '');
      $('#UG').value = data.UG || '';
      $('#CNPJ_UG').value = (data.CNPJ_UG ? data.CNPJ_UG.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5') : '');
      $('#EMAIL_ENTE').value = data.EMAIL_ENTE || '';
      $('#EMAIL_UG').value   = data.EMAIL_UG   || '';

      ['NOME_REP_ENTE','CPF_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE','CARGO_REP_ENTE',
      'NOME_REP_UG','CPF_REP_UG','EMAIL_REP_UG','TEL_REP_UG','CARGO_REP_UG'
      ].forEach(id=>{ const el = $('#'+id); if(el){ el.value=''; neutral(el); } });

      const iso = data.CRP_DATA_VALIDADE_ISO || '';
      if (iso) $('#DATA_VENCIMENTO_ULTIMO_CRP').value = iso;

      const dj = rmAcc(String(data.CRP_DECISAO_JUDICIAL || ''));
      $('#em_adm').checked = (dj==='nao');
      $('#em_jud').checked = (dj==='sim');

      autoselectEsferaByEnte(data.ENTE);

      cnpjOK = true;
      editedFields.clear();

      // Avança para a etapa 1 somente após o modal de loading FECHAR de fato.
      const loadingEl = document.getElementById('modalLoadingSearch');
      if (loadingEl) {
        const onceHidden = () => {
          loadingEl.removeEventListener('hidden.bs.modal', onceHidden);
          defocusIfInsideModal();
          showStep(1);
          updateNavButtons();
          updateFooterAlign();
          $('#UF')?.focus();
        };
        loadingEl.addEventListener('hidden.bs.modal', onceHidden);
      } else {
        // fallback
        showStep(1);
        updateNavButtons();
        updateFooterAlign();
        $('#UF')?.focus();
      }

    } catch (err) {
      const msgs = friendlyErrorMessages(err, 'Não foi possível consultar o CNPJ.');
      if (err && err.status === 404) {
        openConfirmAdd({
          type: 'cnpj',
          value: cnpj,
          onYes: () => {
            clearAllState();
            resetFormUI();
            cnpjOK = true;
            cnpjMissing = true;
            $('#CNPJ_ENTE').value = maskCNPJ(cnpj);
            showStep(1);
            updateNavButtons();
            updateFooterAlign();
            $('#UF')?.focus();
          }
        });
      } else {
        showErro(msgs);
        cnpjOK = false;
      }
    } finally {
      searching = false;
      stopLoading();      // dispara o fechamento do modal; o avanço ocorrerá no 'hidden'
      unlockUI();
      btn?.removeAttribute('disabled');
      updateNavButtons();
      updateFooterAlign();
    }
  });

  /* ========= Busca reps por CPF ========= */
  async function buscarRepByCPF(cpf, target, ev){
    const cpfd = digits(cpf || '');
    if (cpfd.length !== 11) { showAtencao(['Informe um CPF válido.']); return; }

    const forceNoCache = !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));

    try {
      startLoading();

      // ✅ NOVO: pré-checagem do serviço para reduzir 502/timeout
      await waitForService({ timeoutMs: 60000, pollMs: 1500 });

      let r;
      try {
        const url = `${API_BASE}/api/rep-by-cpf?cpf=${cpfd}${forceNoCache ? '&nocache=1' : ''}`;
        r = await fetchJSON(
          url,
          {},
          { label: forceNoCache ? 'rep-by-cpf(nocache)' : 'rep-by-cpf', timeout: 110000, retries: 1 }
        );
      } catch (err1) {
        if (!forceNoCache) {
          r = await fetchJSON(
            `${API_BASE}/api/rep-by-cpf?cpf=${cpfd}&nocache=1`,
            {},
            { label: 'rep-by-cpf(retry-nocache)', timeout: 110000, retries: 0 }
          );
        } else {
          throw err1;
        }
      }

      // ✅ se a API retornar 200 com { missing:true }, abre o modal
      if (r && r.missing) {
        openConfirmAdd({
          type: 'cpf',
          value: cpfd,
          onYes: () => {
            if (target === 'ENTE') { $('#NOME_REP_ENTE')?.focus(); }
            else { $('#NOME_REP_UG')?.focus(); }
          }
        });
        return;
      }

      const data = r.data || {};

      if (target === 'ENTE') {
        $('#NOME_REP_ENTE').value  = data.NOME || '';
        $('#CARGO_REP_ENTE').value = data.CARGO || '';
        $('#EMAIL_REP_ENTE').value = data.EMAIL || '';
        $('#TEL_REP_ENTE').value   = data.TELEFONE || '';
      } else {
        $('#NOME_REP_UG').value  = data.NOME || '';
        $('#CARGO_REP_UG').value = data.CARGO || '';
        $('#EMAIL_REP_UG').value = data.EMAIL || '';
        $('#TEL_REP_UG').value   = data.TELEFONE || '';
      }

      // dispara replicação imediata de e-mails (se válidos) p/ base
      replicateEmails('rep-by-cpf');

    } catch (err) {
      if (err && err.status === 404) {
        // compatibilidade com backend que retorna 404
        openConfirmAdd({
          type: 'cpf',
          value: cpfd,
          onYes: () => {
            if (target === 'ENTE') { $('#NOME_REP_ENTE')?.focus(); }
            else { $('#NOME_REP_UG')?.focus(); }
          }
        });
      } else {
        showErro(friendlyErrorMessages(err, 'Falha ao consultar CPF.'));
      }
    } finally {
      stopLoading();
      unlockUI();
    }
  }

  /* Atualize os listeners para passar o evento (suporte a nocache por Shift/Ctrl/Cmd) */
  $('#btnPesqRepEnte')?.addEventListener('click', (ev)=> buscarRepByCPF($('#CPF_REP_ENTE').value,'ENTE', ev));
  $('#btnPesqRepUg')  ?.addEventListener('click', (ev)=> buscarRepByCPF($('#CPF_REP_UG').value,  'UG',   ev));


  async function upsertRepresentantes(){
    const base = {
      UF: $('#UF').value.trim(),
      ENTE: $('#ENTE').value.trim(),
      UG: $('#UG').value.trim(),
    };
    const reps = [
      { ...base, NOME: $('#NOME_REP_ENTE').value.trim(), CPF: digits($('#CPF_REP_ENTE').value),
        EMAIL: $('#EMAIL_REP_ENTE').value.trim(), TELEFONE: $('#TEL_REP_ENTE').value.trim(), CARGO: $('#CARGO_REP_ENTE').value.trim(),
        UG: '' },
      { ...base, NOME: $('#NOME_REP_UG').value.trim(), CPF: digits($('#CPF_REP_UG').value),
        EMAIL: $('#EMAIL_REP_UG').value.trim(), TELEFONE: $('#TEL_REP_UG').value.trim(), CARGO: $('#CARGO_REP_UG').value.trim() }
    ];
    for (const rep of reps){
      if (digits(rep.CPF).length===11 && rep.NOME){
        fetchJSON(`${API_BASE}/api/upsert-rep`,
          { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rep) },
          { timeout: 8000, retries: 0, label: 'upsert-rep' }
        ).catch(()=>{});
      }
    }
  }

  // ======== carimbos ========
  function fillNowHiddenFields(){
    const now = new Date();
    $('#MES').value               = String(now.getMonth()+1).padStart(2,'0');
    $('#DATA_TERMO_GERADO').value = fmtBR(now);
    $('#HORA_TERMO_GERADO').value = fmtHR(now);
    $('#ANO_TERMO_GERADO').value  = String(now.getFullYear());
  }

  // ======== payload ========
  function buildPayload(){
    return {
      ENTE: $('#ENTE').value.trim(),
      UF: $('#UF').value.trim(),
      CNPJ_ENTE: digits($('#CNPJ_ENTE').value),
      EMAIL_ENTE: $('#EMAIL_ENTE').value.trim(),
      NOME_REP_ENTE: $('#NOME_REP_ENTE').value.trim(),
      CARGO_REP_ENTE: $('#CARGO_REP_ENTE').value.trim(),
      CPF_REP_ENTE: digits($('#CPF_REP_ENTE').value),
      EMAIL_REP_ENTE: $('#EMAIL_REP_ENTE').value.trim(),
      UG: $('#UG').value.trim(),
      CNPJ_UG: digits($('#CNPJ_UG').value),
      EMAIL_UG: $('#EMAIL_UG').value.trim(),
      NOME_REP_UG: $('#NOME_REP_UG').value.trim(),
      CARGO_REP_UG: $('#CARGO_REP_UG').value.trim(),
      CPF_REP_UG: digits($('#CPF_REP_UG').value),
      EMAIL_REP_UG: $('#EMAIL_REP_UG').value.trim(),
      DATA_VENCIMENTO_ULTIMO_CRP: $('#DATA_VENCIMENTO_ULTIMO_CRP').value || '',
      TIPO_EMISSAO_ULTIMO_CRP:
        ($('#em_adm').checked && 'Administrativa') ||
        ($('#em_jud').checked && 'Judicial') || '',
      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i=>i.value),
      CELEBRACAO_TERMO_PARCELA_DEBITOS: $$('input#parc60, input#parc300').filter(i=>i.checked).map(i=>i.value).join('; '),
      REGULARIZACAO_PENDEN_ADMINISTRATIVA: $$('input#reg_sem_jud, input#reg_com_jud').filter(i=>i.checked).map(i=>i.value).join('; '),
      DEFICIT_ATUARIAL: $$('input#eq_implano, input#eq_prazos, input#eq_plano_alt').filter(i=>i.checked).map(i=>i.value).join('; '),
      CRITERIOS_ESTRUT_ESTABELECIDOS: $$('input#org_ugu, input#org_outros').filter(i=>i.checked).map(i=>i.value).join('; '),
      MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: $$('input#man_cert, input#man_melhoria, input#man_acomp').filter(i=>i.checked).map(i=>i.value).join('; '),
      COMPROMISSO_FIRMADO_ADESAO: $$('input[name="COMPROMISSOS[]"]:checked').map(i=>i.value).join('; '),
      PROVIDENCIA_NECESS_ADESAO: $$('input[name="PROVIDENCIAS[]"]:checked').map(i=>i.value).join('; '),
      CONDICAO_VIGENCIA: $$('input[name="CONDICOES[]"]:checked').map(i => i.value).join('; '),
      MES: $('#MES').value,
      DATA_TERMO_GERADO: $('#DATA_TERMO_GERADO').value,
      HORA_TERMO_GERADO: $('#HORA_TERMO_GERADO').value,
      ANO_TERMO_GERADO: $('#ANO_TERMO_GERADO').value,
      __snapshot_base: snapshotBase,
      __user_changed_fields: Array.from(editedFields),
      IDEMP_KEY: takeIdemKey() || ''
    };
  }
  // ======== Preview (opcional) ========
  function openTermoWithPayload(payload, autoFlag){
    const esfera = ($('#esf_mun')?.checked ? 'RPPS Municipal' :
                    ($('#esf_est')?.checked ? 'Estadual/Distrital' : ''));
    const qs = new URLSearchParams({
      uf: payload.UF, ente: payload.ENTE, cnpj_ente: $('#CNPJ_ENTE').value,
      email_ente: payload.EMAIL_ENTE,
      ug: payload.UG, cnpj_ug: $('#CNPJ_UG').value,
      email_ug: payload.EMAIL_UG,
      esfera,
      nome_rep_ente: payload.NOME_REP_ENTE, cpf_rep_ente: $('#CPF_REP_ENTE').value,
      cargo_rep_ente: payload.CARGO_REP_ENTE, email_rep_ente: payload.EMAIL_REP_ENTE,
      nome_rep_ug: payload.NOME_REP_UG, cpf_rep_ug: $('#CPF_REP_UG').value,
      cargo_rep_ug: payload.CARGO_REP_UG, email_rep_ug: payload.EMAIL_REP_UG,
      venc_ult_crp: $('#DATA_VENCIMENTO_ULTIMO_CRP').value,
      tipo_emissao_crp: payload.TIPO_EMISSAO_ULTIMO_CRP,
      celebracao: payload.CELEBRACAO_TERMO_PARCELA_DEBITOS,
      regularizacao: payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA,
      deficit: payload.DEFICIT_ATUARIAL,
      criterios_estrut: payload.CRITERIOS_ESTRUT_ESTABELECIDOS,
      manutencao_normas: payload.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS,
      compromisso: payload.COMPROMISSO_FIRMADO_ADESAO,
      providencias: payload.PROVIDENCIA_NECESS_ADESAO,
      condicao_vigencia: payload.CONDICAO_VIGENCIA,
      data_termo: $('#DATA_TERMO_GERADO').value,
      auto: String(autoFlag || '1')
    });

    const compAgg = String(payload.COMPROMISSO_FIRMADO_ADESAO || '');
    [['5.1','5\\.1'], ['5.2','5\\.2'], ['5.3','5\\.3'], ['5.4','5\\.4'], ['5.5','5\\.5'], ['5.6','5\\.6'], ['5.7','5\\.7']]
      .forEach(([code, rx]) => {
        if (new RegExp(`(^|\\D)${rx}(\\D|$)`).test(compAgg)) qs.append('comp', code);
      });


    payload.CRITERIOS_IRREGULARES.forEach((c, i) => qs.append(`criterio${i+1}`, c));
    window.open(`termo.html?${qs.toString()}`, '_blank', 'noopener');
  }

  /* ========= Helper: gerar & baixar PDF ========= */
  async function gerarBaixarPDF(payload){
    const esfera =
      ($('#esf_mun')?.checked ? 'RPPS Municipal' :
      ($('#esf_est')?.checked ? 'Estadual/Distrital' : ''));
    const body = { ...payload, ESFERA: esfera };

    try {
      // 1ª tentativa com timeout/retry interno
      const blob = await fetchBinary(
        `${API_BASE}/api/termo-pdf`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { label: 'termo-pdf', timeout: 60000, retries: 1 }
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const ente = String(payload.ENTE || 'termo-adesao')
        .normalize('NFD').replace(/\p{Diacritic}/gu,'')
        .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
        .toLowerCase();
      a.download = `termo-${ente}.pdf`;

      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const status = e?.status || 0;
      const looksLikeCorsOrFetch =
        msg.includes('cors') || msg.includes('preflight') ||
        msg.includes('access-control-allow-origin') ||
        msg.includes('failed to fetch') || msg.includes('typeerror: failed to fetch');

      const canWait =
        status === 502 || status === 503 || status === 504 ||
        msg.includes('timeout:') || !navigator.onLine ||
        msg.includes('bad gateway') || looksLikeCorsOrFetch;

      if (canWait) {
        const ok = await waitForService({ timeoutMs: 60_000, pollMs: 2500 });
        if (ok) {
          const blob = await fetchBinary(
            `${API_BASE}/api/termo-pdf`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            { label: 'termo-pdf(retry-after-wait)', timeout: 60000, retries: 0 }
          );

          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;

          const ente = String(payload.ENTE || 'termo-adesao')
            .normalize('NFD').replace(/\p{Diacritic}/gu,'')
            .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
            .toLowerCase();
          a.download = `termo-${ente}.pdf`;

          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          return;
        }
      }
      throw e;
    }
  }

  /* ========= AÇÃO: Gerar Formulário (download do PDF) ========= */
  let gerarBusy = false;

  btnGerar?.addEventListener('click', async () => {
    if (gerarBusy) return;

    for (let s = 1; s <= 8; s++) { if (!validateStep(s)) return; }

    gerarBusy = true;
    if (btnGerar) btnGerar.disabled = true;

    fillNowHiddenFields();
    const payload = buildPayload();

    try {
      safeShowModal(modalGerandoPdf);
      await gerarBaixarPDF(payload);
      try { modalGerandoPdf.hide(); } catch {}
      safeShowModal(modalSucesso);
    } catch (e) {
      try { modalGerandoPdf.hide(); } catch {}
      showErro(['Não foi possível gerar o PDF.', e?.message || '']);
    } finally {
      unlockUI();  // não feche a modal de sucesso/erro
      if (btnGerar) btnGerar.disabled = false;
      gerarBusy = false;
    }
  });

  /* ========= Submit / Finalizar (com espera + reenvio seguro) ========= */
  const form = document.getElementById('regularidadeForm');

  /* helper: limpa UI + memória do formulário */
  function resetFormUI(){
    try { form?.reset(); } catch {}
    $$('.is-valid, .is-invalid').forEach(el => el.classList.remove('is-valid','is-invalid'));
    $$('input[type="checkbox"], input[type="radio"]').forEach(el => el.checked = false);
    editedFields.clear();
    snapshotBase = null;
    cnpjOK = false;
  }


  // evita Enter antes da etapa 8
  form?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && step < 8) {
      const t = e.target;
      const isTextualInput =
        t && t.tagName === 'INPUT' && !['button','submit','checkbox','radio','file'].includes(t.type);
      const isTextarea = t && t.tagName === 'TEXTAREA';
      if (isTextualInput || isTextarea) e.preventDefault();
    }
  });

  // Enter na pesquisa
  document.getElementById('CNPJ_ENTE_PESQ')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btnPesquisar')?.click();
    }
  });

  form?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    for (let s=1; s<=8; s++){ if(!validateStep(s)) return; }

    await upsertBaseIfMissing();
    await upsertRepresentantes();

    fillNowHiddenFields();

    // gera/guarda chave de idempotência antes do 1º POST
    const idem = takeIdemKey() || newIdemKey();
    rememberIdemKey(idem);

    const payload = buildPayload(); // incluirá IDEMP_KEY (se existir)

    const submitOriginalHTML = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = 'Finalizando…';

    // dispara modal "Aguarde..." após 3s se ainda não finalizou
    let savingModalTimer = setTimeout(() => {
      try { safeShowModal(modalSalvando); } catch {}
    }, 3000);

    try {
      // 1ª tentativa
      await fetchJSON(
        `${API_BASE}/api/gerar-termo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idem
          },
          body: JSON.stringify(payload),
        },
        { label: 'gerar-termo', timeout: 30000, retries: 1 }
      );

      closeSavingModal(savingModalTimer);
      clearIdemKey();
      btnSubmit.innerHTML = 'Finalizado ✓';

      // Limpa TUDO (zera rascunho) e volta para o passo 0
      setTimeout(() => {
        form.reset();
        $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
        $$('input[type="checkbox"], input[type="radio"]').forEach(el=> el.checked=false);
        editedFields.clear();
        snapshotBase = null;
        cnpjOK = false;
        clearAllState(); // <- apaga STORAGE_KEY + idem
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = submitOriginalHTML;
        showStep(0);
      }, 800);
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      const status = err?.status || 0;

      // também considera preflight/CORS/Failed to fetch como caso de "esperar e reenviar"
      const looksLikeCorsOrFetch =
        msg.includes('cors') ||
        msg.includes('preflight') ||
        msg.includes('access-control-allow-origin') ||
        msg.includes('failed to fetch') ||
        msg.includes('typeerror: failed to fetch');

      const canWait =
        status === 502 || status === 503 || status === 504 ||
        msg.includes('timeout:') || !navigator.onLine ||
        msg.includes('bad gateway') || looksLikeCorsOrFetch;

      if (canWait) {
        btnSubmit.innerHTML = 'Aguardando serviço…';
        const ok = await waitForService({ timeoutMs: 60_000, pollMs: 2500 });
        if (ok) {
          try {
            await fetchJSON(
              `${API_BASE}/api/gerar-termo`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Idempotency-Key': idem
                },
                body: JSON.stringify(payload),
              },
              { label: 'gerar-termo(retry-after-wait)', timeout: 30000, retries: 0 }
            );
            closeSavingModal(savingModalTimer);
            clearIdemKey();
            btnSubmit.innerHTML = 'Finalizado ✓';
            setTimeout(() => {
              form.reset();
              $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
              $$('input[type="checkbox"], input[type="radio"]').forEach(el=> el.checked=false);
              editedFields.clear();
              snapshotBase = null;
              cnpjOK = false;
              clearAllState();
              btnSubmit.disabled = false;
              btnSubmit.innerHTML = submitOriginalHTML;
              showStep(0);
            }, 800);
            return;
          } catch (err2) {
            closeSavingModal(savingModalTimer);
            showErro(friendlyErrorMessages(err2, 'Falha ao registrar o termo.'));
          }
        } else {
          closeSavingModal(savingModalTimer);
          showErro(['Servidor indisponível no momento. Tente novamente mais tarde.']);
        }
      } else {
        closeSavingModal(savingModalTimer);
        showErro(friendlyErrorMessages(err, 'Falha ao registrar o termo.'));
      }

      // estado de erro → mantém botão habilitado e preserva idemKey para reenvio manual
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = submitOriginalHTML;
    }

  });

  function restoreState({ ignore = false } = {}) {
    if (ignore) {            
      showStep(0);
      return;
    }

    const st = loadState();
    if (!st) { showStep(0); return; }

    const now = Date.now();
    if (AUTO_CLEAR_DRAFTS && st.lastSaved && (now - st.lastSaved > FORM_TTL_MS)) {
      clearAllState();
      showStep(0);
      return;
    }

    const vals = st.values || {};
    let n = Number.isFinite(st.step) ? Number(st.step) : 0;

    if (n === 0) {
      cnpjOK = false;
      const pesq = document.getElementById('CNPJ_ENTE_PESQ');
      if (pesq) { pesq.value = ''; /* neutral(pesq);*/ }
    } else {
      cnpjOK = digits(vals.CNPJ_ENTE || vals.CNPJ_UG || '').length === 14;
    }

    showStep(Math.max(0, Math.min(8, n)));
    if (st.seenWelcome) { try { modalWelcome.hide(); } catch {} }
  }

  // antes era: restoreState();
  const TAB_FLAG = 'rpps-tab-init';
  const ignoreRestoreThisTab = !sessionStorage.getItem(TAB_FLAG);
  sessionStorage.setItem(TAB_FLAG, '1');
  restoreState({ ignore: ignoreRestoreThisTab });
})();
