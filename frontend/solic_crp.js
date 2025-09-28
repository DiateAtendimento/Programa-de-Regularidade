// solic_crp.js — fluxo completo da Solicitação de CRP Emergencial (isolado da Adesão)

(() => {
  /* ========= Config ========= */
  const API_BASE =
  (window.__API_BASE && String(window.__API_BASE).replace(/\/+$/, '')) ||
  (location.hostname.endsWith('netlify.app') ? '/_api' : '/api');

const api = (p) => `${API_BASE}${p.startsWith('/') ? p : '/' + p}`;

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
      try{
        const res = await fetch(finalURL, {
          method, headers, body, signal: ctrl.signal,
          cache:'no-store', credentials:'same-origin', redirect:'follow', mode:'cors'
        });
        clearTimeout(to);
        if(!res.ok){
          // tentar extrair erro JSON quando houver
          const isJson = (res.headers.get('content-type')||'').includes('application/json');
          const data   = isJson ? (await res.json().catch(()=>null)) : null;
          const err    = new Error((data && (data.error||data.message)) || `HTTP ${res.status}`);
          err.status = res.status; throw err;
        }
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
      }catch(e){
        clearTimeout(to);
        const m = String(e?.message||'').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');
        const retriable =
          (isHttp && (e.status===429 || e.status===502 || e.status===503 || e.status===504 || e.status>=500)) ||
          m.includes('timeout:') || m.includes('etimedout') || m.includes('abort') ||
          m.includes('econnreset') || m.includes('socket hang up') || m.includes('eai_again') ||
          m.includes('failed to fetch') || (!navigator.onLine);

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
    btnGerar: $('#btnGerarForm'),
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

    // etapa 2
    cpfRepEnte: $('#CPF_REP_ENTE'), nomeRepEnte: $('#NOME_REP_ENTE'),
    cargoRepEnte: $('#CARGO_REP_ENTE'), emailRepEnte: $('#EMAIL_REP_ENTE'), telRepEnte: $('#TEL_REP_ENTE'),
    cpfRepUg: $('#CPF_REP_UG'), nomeRepUg: $('#NOME_REP_UG'),
    cargoRepUg: $('#CARGO_REP_UG'), emailRepUg: $('#EMAIL_REP_UG'), telRepUg: $('#TEL_REP_UG'),

    // etapa 3
    dataUltCrp: $('#DATA_VENCIMENTO_ULTIMO_CRP'),
    tipoAdm: $('#em_adm'), tipoJud: $('#em_jud'),
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
      'DATA_VENCIMENTO_ULTIMO_CRP','JUSTIFICATIVAS_GERAIS'
    ].forEach(id=>{ const e=$('#'+id); if(e) data.values[id]=e.value; });

    data.values['esf_mun'] = !!el.esfMun?.checked;
    data.values['esf_est'] = !!el.esfEst?.checked;
    data.values['TIPO_EMISSAO_ULT'] = el.tipoAdm?.checked ? 'Administrativa' : (el.tipoJud?.checked ? 'Judicial' : '');

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

    // 4.4
    data.values['F44_CRITERIOS[]']   = $$(`#F44_CRITERIOS input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_DECLS[]']       = $$(`#blk_44 .d-flex input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_FINALIDADES[]'] = $$(`#F44_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value);
    data.values['F44_ANEXOS']        = $('#F44_ANEXOS')?.value || '';

    // 4.5
    data.values['F45_OK451'] = !!$('#blk_45 input[type="checkbox"]:checked');
    data.values['F45_DOCS']  = $('#F45_DOCS')?.value || '';
    data.values['F45_JUST']  = $('#F45_JUST')?.value || '';

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
      Object.entries(vals).forEach(([k,v])=>{
        if (k.endsWith('[]')){
          $$(`input[name="${k}"]`).forEach(i => { i.checked = Array.isArray(v) && v.includes(i.value); });
        }
      });
      Object.entries(vals).forEach(([k,v])=>{
        if (k.endsWith('[]')) return;
        const e = $('#'+k); if(!e) return;
        if (e.type==='checkbox' || e.type==='radio'){ e.checked = !!v; } else { e.value = v ?? ''; }
      });

      if(vals['TIPO_EMISSAO_ULT']==='Administrativa') el.tipoAdm.checked = true;
      if(vals['TIPO_EMISSAO_ULT']==='Judicial')      el.tipoJud.checked = true;

      return st;
    }catch{ return null; }
  }

  /* ========= Stepper fallback ========= */
  let curStep = 0;
  function ensureStepperFallback(){
    if(!el.sections.length || !el.btnNext || !el.btnPrev) return;
    function render(){
      el.sections.forEach((sec,i)=> sec.style.display = (i===curStep ? '' : 'none'));
      el.dots.forEach((d,i)=> d.classList.toggle('active', i===curStep));
      el.btnPrev.style.visibility = (curStep===0 ? 'hidden' : 'visible');
      el.btnNext.classList.toggle('d-none', curStep === el.sections.length-1);
      el.btnSubmit.classList.toggle('d-none', !(curStep === el.sections.length-1));

      // encaixa Next no slot da etapa 0
      const slot = el.slotNextStep0;
      if(slot){
        if(curStep===0 && el.btnNext.parentElement!==slot) slot.appendChild(el.btnNext);
        if(curStep!==0 && el.btnNext.parentElement===slot) el.navFooter?.insertBefore(el.btnNext, el.btnSubmit);
      }
      saveState();
    }
    function next(){
      if(curStep === 0 && el.hasGescon?.value!=='1'){ showModal('modalBusca'); return; }
      // valida fase visível quando estiver na etapa 4
      if(curStep === 4){
        const vf = validarFaseSelecionada();
        if(!vf.ok){ showAtencao([vf.motivo]); return; }
      }
      if(curStep < el.sections.length-1){ curStep++; render(); }
    }
    function prev(){ if(curStep>0){ curStep--; render(); } }

    el.btnNext.addEventListener('click', next);
    el.btnPrev.addEventListener('click', prev);

    // restaura estado
    const st = loadState();
    curStep = Number.isFinite(st?.step) ? Math.max(0, Math.min(el.sections.length-1, Number(st.step))) : 0;
    render();
  }

  /* ========= Modais (Atenção/Erro) ========= */
  function showAtencao(msgs){
    const list = $('#modalAtencaoLista'); if(list){ list.innerHTML = msgs.map(m=>`<li>${m}</li>`).join(''); }
    showModal('modalAtencao');
  }
  function showErro(msgs){
    const list = $('#modalErroLista'); if(list){ list.innerHTML = msgs.map(m=>`<li>${m}</li>`).join(''); }
    showModal('modalErro');
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
    // servidor expõe: POST /api/gescon/termo-enc
    return fetchJSON(api('/gescon/termo-enc'), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cnpj })
    }, { label:'gescon/termo-enc', retries: 0 });
  }

  async function consultarTermosRegistrados(cnpj){
    // esperado backend: { ok:true, ente:{uf,nome,cnpj,ug,cnpj_ug,email,email_ug}, responsaveis:{ente:{...},ug:{...}}, crp:{data_venc,tipo,irregulares:[]}}
    return fetchJSON(api('/termos-registrados'), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cnpj })
    }, { label:'termos-registrados', retries: 0 });
  }

  async function onPesquisar(ev){
    if(searching) return;
    const cnpj = digits(el.cnpjInput?.value||'');
    if(cnpj.length!==14){ showAtencao(['Informe um CNPJ válido (14 dígitos).']); return; }

    searching = true;
    const btn = el.btnPesquisar;
    const old = btn?.innerHTML;
    btn && (btn.disabled = true, btn.innerHTML = 'Pesquisando…');

    try{
      const data = await consultarGesconByCnpj(cnpj);
      const ok = data && data.n_gescon && data.uf && data.ente && data.data_enc_via_gescon;
      if(!ok){
        el.hasGescon.value = '0';
        showModal('modalBusca');
        return;
      }
      // info box
      el.hasGescon.value = '1';
      el.spanNGescon.textContent  = data.n_gescon || '';
      el.spanDataEnc.textContent  = data.data_enc_via_gescon || '';
      el.spanUfGescon.textContent = data.uf || '';
      el.spanEnteGescon.textContent = data.ente || '';
      el.boxGescon?.classList.remove('d-none');
      el.infoDataEncGescon && (el.infoDataEncGescon.textContent = data.data_enc_via_gescon || '—');

      // hidrata 1–3
      await hidratarTermosRegistrados(cnpj);
      // avança para etapa 1 (se estivermos no 0)
      if(curStep===0){ curStep=1; ensureStepperFallback(); }
    }catch(err){
      console.error(err);
      showErro(friendlyErrorMessages(err, 'Falha ao consultar informações.'));
    }finally{
      btn && (btn.disabled=false, btn.innerHTML=old||'Pesquisar');
      searching = false;
    }
  }

  async function hidratarTermosRegistrados(cnpj){
    try{
      const data = await consultarTermosRegistrados(cnpj);
      const ente = data?.ente||{}, resp = data?.responsaveis||{}, crp=data?.crp||{};

      if (ente.uf)   el.uf.value = ente.uf;
      if (ente.nome) el.ente.value = ente.nome;
      if (el.cnpjEnte) el.cnpjEnte.value = maskCNPJ(ente.cnpj || cnpj);
      if (ente.email) el.emailEnte.value = ente.email;

      if (ente.ug) el.ug.value = ente.ug;
      if (ente.cnpj_ug) el.cnpjUg.value = maskCNPJ(ente.cnpj_ug);
      if (ente.email_ug) el.emailUg.value = ente.email_ug;

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

      if (crp.data_venc) el.dataUltCrp.value = crp.data_venc;
      if (crp.tipo === 'Administrativa') el.tipoAdm.checked = true;
      if (crp.tipo === 'Judicial')       el.tipoJud.checked = true;

      if (Array.isArray(crp.irregulares)){
        crp.irregulares.forEach(v=>{
          const inp = $(`input[name="CRITERIOS_IRREGULARES[]"][value="${CSS.escape(v)}"]`, el.grpCrit);
          if (inp) inp.checked = true;
        });
      }

      // popular listas fase com base nos critérios
      popularListasFaseComBaseNosCritérios();
      saveState();
    }catch(e){
      console.warn('Não foi possível hidratar Termos_registrados:', e);
    }
  }

  /* ========= Fase 4 (mostrar blocos + validar) ========= */
  function setupFase4Toggles(){
    const map = { '4.1': el.blk41, '4.2': el.blk42, '4.3': el.blk43, '4.4': el.blk44, '4.5': el.blk45, '4.6': el.blk46 };
    function showBlock(val){
      Object.values(map).forEach(b=> b&&b.classList.add('d-none'));
      const t = map[val]; if(t){ t.classList.remove('d-none'); t.scrollIntoView({behavior:'smooth',block:'start'}); }
    }
    el.faseRadios.forEach(r => r.addEventListener('change', e => { showBlock(e.target.value); saveState(); }));
  }

  function validarFaseSelecionada(){
    const fase = $('input[name="FASE_PROGRAMA"]:checked');
    if(!fase) return { ok:false, motivo:'Selecione uma fase (4.1 a 4.6).' };

    switch(fase.value){
      case '4.1': {
        const opt = $('input[name="F41_OPCAO"]:checked', el.blk41);
        if(!opt) return { ok:false, motivo:'Na fase 4.1, selecione 4.1.1 ou 4.1.2.' };
        return { ok:true };
      }
      case '4.2': {
        const marc = $$('input[type="checkbox"]:checked', el.f42Lista);
        if(!marc.length) return { ok:false, motivo:'Na fase 4.2, marque ao menos um item (a–g).' };
        return { ok:true };
      }
      case '4.3': {
        const marc = $$('input[type="checkbox"]:checked', el.f43Lista);
        const just = ($('#F43_JUST')?.value||'').trim();
        if(!marc.length && !just) return { ok:false, motivo:'Na fase 4.3, marque ao menos um critério ou preencha as justificativas.' };
        return { ok:true };
      }
      case '4.4': {
        const crits = $$('input[type="checkbox"]:checked', el.f44Crits);
        if(!crits.length) return { ok:false, motivo:'Na fase 4.4, selecione ao menos um critério (4.4.1).' };
        return { ok:true };
      }
      case '4.5': {
        const ok451 = $('#blk_45 input[type="checkbox"]:checked');
        const docs = ($('#F45_DOCS')?.value||'').trim();
        const jus  = ($('#F45_JUST')?.value||'').trim();
        if(!ok451 && !docs && !jus) return { ok:false, motivo:'Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas.' };
        return { ok:true };
      }
      case '4.6': {
        const crits = $$('input[type="checkbox"]:checked', el.f46Crits);
        const nivel = $('#F46_PROGESTAO')?.value || '';
        const porte = $('#F46_PORTE')?.value || '';
        if(!crits.length) return { ok:false, motivo:'Na fase 4.6, selecione ao menos um critério em 4.6.1.' };
        if(!nivel || !porte) return { ok:false, motivo:'Informe nível Pró-Gestão e Porte ISP-RPPS em 4.6.2.' };
        return { ok:true };
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

    if(el.f43Lista && !el.f43Lista.children.length){
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
    if(!el.dataUltCrp.value) msgs.push('Data de vencimento do último CRP (3.1)');
    if(!(el.tipoAdm.checked || el.tipoJud.checked)) msgs.push('Tipo de emissão do último CRP (3.2)');

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
    const esfera =
      (el.esfMun?.checked ? 'RPPS Municipal' :
      (el.esfEst?.checked ? 'Estadual/Distrital' : ''));

    const faseSel = $('input[name="FASE_PROGRAMA"]:checked')?.value || '';

    return {
      // gate Gescon
      HAS_TERMO_ENC_GESCON: el.hasGescon?.value === '1',
      N_GESCON: el.spanNGescon?.textContent || '',
      DATA_ENC_VIA_GESCON: el.spanDataEnc?.textContent || '',

      // seção 1
      ESFERA: esfera,
      UF: el.uf.value.trim(),
      ENTE: el.ente.value.trim(),
      CNPJ_ENTE: digits(el.cnpjEnte.value),
      EMAIL_ENTE: el.emailEnte.value.trim(),
      UG: el.ug.value.trim(),
      CNPJ_UG: digits(el.cnpjUg.value),
      EMAIL_UG: el.emailUg.value.trim(),

      // seção 2
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

      // seção 3
      DATA_VENCIMENTO_ULTIMO_CRP: el.dataUltCrp.value || '',
      TIPO_EMISSAO_ULTIMO_CRP: (el.tipoAdm.checked && 'Administrativa') || (el.tipoJud.checked && 'Judicial') || '',
      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i=>i.value),

      // seção 4 (fase + subitens)
      FASE_PROGRAMA: faseSel,
      F41_OPCAO: $('input[name="F41_OPCAO"]:checked')?.value || '',
      F42_LISTA: $$(`#F42_LISTA input[type="checkbox"]:checked`).map(i=>i.value),
      F43_LISTA: $$(`#F43_LISTA input[type="checkbox"]:checked`).map(i=>i.value),
      F43_JUST:  $('#F43_JUST')?.value || '',
      F43_PLANO: $('#F43_PLANO')?.value || '',
      F44_CRITERIOS:   $$(`#F44_CRITERIOS input[type="checkbox"]:checked`).map(i=>i.value),
      F44_DECLS:       $$(`#blk_44 .d-flex input[type="checkbox"]:checked`).map(i=>i.value),
      F44_FINALIDADES: $$(`#F44_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value),
      F44_ANEXOS:      $('#F44_ANEXOS')?.value || '',
      F45_OK451: !!$('#blk_45 input[type="checkbox"]:checked'),
      F45_DOCS:  $('#F45_DOCS')?.value || '',
      F45_JUST:  $('#F45_JUST')?.value || '',
      F46_CRITERIOS:   $$(`#F46_CRITERIOS input[type="checkbox"]:checked`).map(i=>i.value),
      F46_PROGESTAO:   $('#F46_PROGESTAO')?.value || '',
      F46_PORTE:       $('#F46_PORTE')?.value || '',
      F46_JUST_D:      $('#F46_JUST_D')?.value || '',
      F46_DOCS_D:      $('#F46_DOCS_D')?.value || '',
      F46_JUST_E:      $('#F46_JUST_E')?.value || '',
      F46_DOCS_E:      $('#F46_DOCS_E')?.value || '',
      F46_FINALIDADES: $$(`#F46_FINALIDADES input[type="checkbox"]:checked`).map(i=>i.value),
      F46_ANEXOS:      $('#F46_ANEXOS')?.value || '',
      F46_JUST_PLANOS: $('#F46_JUST_PLANOS')?.value || '',
      F46_COMP_CUMPR:  $('#F46_COMP_CUMPR')?.value || '',

      // seção 5
      JUSTIFICATIVAS_GERAIS: el.justGerais?.value || '',

      // carimbos
      MES: el.mes.value,
      DATA_SOLIC_GERADA: el.dataSol.value,
      HORA_SOLIC_GERADA: el.horaSol.value,
      ANO_SOLIC_GERADA: el.anoSol.value,

      // idempotência
      IDEMP_KEY: takeIdemKey() || ''
    };
  }

  /* ========= Gerar & baixar PDF ========= */
  async function gerarBaixarPDF(payload){
    const blob = await fetchBinary(
      api('/termo-pdf'),
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) },
      { label:'termo-pdf', timeout:60000, retries:1 }
    );

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    const enteSlug = String(payload.ENTE||'solic-crp')
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'').toLowerCase();
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
      await fetchJSON(api('/gerar-termo'), {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Idempotency-Key':idem},
      body: JSON.stringify(payload)
      }, { label:'gerar-termo', timeout:30000, retries:1 });


      clearTimeout(t);
      try{ bootstrap.Modal.getOrCreateInstance($('#modalSalvando')).hide(); }catch{}
      clearIdemKey();
      btn.innerHTML = 'Finalizado ✓';

      // limpar formulário e estado
      setTimeout(()=>{
        try{ form.reset(); }catch{}
        clearAllState();
        btn.disabled=false; btn.innerHTML=old;
        curStep=0; ensureStepperFallback();
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

  /* ========= Boot ========= */
  function init(){
    bindMasks();
    el.btnPesquisar?.addEventListener('click', onPesquisar, false);
    setupFase4Toggles();
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
    form?.addEventListener('input', ()=> setTimeout(saveState, 300));
    form?.addEventListener('change', ()=> setTimeout(saveState, 300));

    // restore & stepper
    ensureStepperFallback();
    window.addEventListener('beforeunload', saveState);
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
  else{ init(); }
})();
