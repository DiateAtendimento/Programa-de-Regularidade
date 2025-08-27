// script.js — Multi-etapas com: máscaras, stepper, modais/Lottie, buscas e validação
(() => {
  /* ========= Config API ========= */
  const API_BASE = (() => {
    const h = location.hostname;
    if (h.endsWith('netlify.app')) return 'https://programa-de-regularidade.onrender.com';
    if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:3000';
    return '';
  })();

  /* ========= Helpers ========= */
  const $  = (s, r=document)=> r.querySelector(s);
  const $$ = (s, r=document)=> Array.from(r.querySelectorAll(s));
  const digits = v => String(v||'').replace(/\D+/g,'');
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fmtBR = d => d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const fmtHR = d => d.toLocaleTimeString('pt-BR',{hour12:false,timeZone:'America/Sao_Paulo'});
  const rmAcc = s => String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();

  // Modais
  const modalErro     = new bootstrap.Modal($('#modalErro'));
  const modalBusca    = new bootstrap.Modal($('#modalBusca'));
  const modalSucesso  = new bootstrap.Modal($('#modalSucesso'));
  const modalWelcome  = new bootstrap.Modal($('#modalWelcome'));
  const modalLoadingSearch = new bootstrap.Modal($('#modalLoadingSearch'), { backdrop:'static', keyboard:false });

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(()=> modalWelcome.show(), 150);
  });

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
  $('#modalBusca')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieErrorBusca', 'animacao/atencao-info.json', { loop:false, autoplay:true });
  });

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
      title.textContent = 'Atenção';
      mountLottie('lottieError', 'animacao/confirm-error.json', { loop:false, autoplay:true });
    }
  }
  function showAtencao(msgs){
    const ul = $('#modalErroLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
    setErroHeader('atencao');
    modalErro.show();
  }
  function showErro(msgs){
    const ul = $('#modalErroLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
    setErroHeader('erro');
    modalErro.show();
  }

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

  /* ========= Stepper / Navegação ========= */
  let step = 0;   // 0..8
  let cnpjOK = false;

  const sections = $$('[data-step]');
  const stepsUI  = $$('#stepper .step');
  const btnPrev  = $('#btnPrev');
  const btnNext  = $('#btnNext');
  const btnSubmit= $('#btnSubmit');
  const navFooter= $('#navFooter');
  const pesquisaRow = $('#pesquisaRow');

  // âncora para recolocar o Próximo no rodapé
  const nextAnchor = document.createComment('next-button-anchor');
  navFooter?.insertBefore(nextAnchor, btnSubmit);

  // wrapper col-auto para alinhar com o "Pesquisar" na etapa 0
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
    btnPrev.classList.toggle('d-none', step < 1);
    btnNext.disabled = (step === 0 && !cnpjOK);
    btnNext.classList.toggle('d-none', step===8);
    btnSubmit.classList.toggle('d-none', step!==8);
  }
  function updateFooterAlign(){
    if (!navFooter) return;
    [btnPrev, btnNext, btnSubmit].forEach(b => b && b.classList.remove('ms-auto'));
    if (step === 8) btnSubmit?.classList.add('ms-auto');
    else if (step > 0) btnNext?.classList.add('ms-auto');
  }
  function showStep(n){
    step = Math.max(0, Math.min(8, n));
    sections.forEach(sec => sec.style.display = (Number(sec.dataset.step)===step ? '' : 'none'));
    const activeIdx = Math.min(step, stepsUI.length-1);
    stepsUI.forEach((s,i)=> s.classList.toggle('active', i===activeIdx));
    placeNextInline(step === 0);
    updateNavButtons();
    updateFooterAlign();
  }

  showStep(0);

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
      if (s===1) {
        const items = $$('input[name="ESFERA_GOVERNO[]"]');
        const ok = items.some(i=>i.checked);
        items.forEach(i => i.classList.toggle('is-invalid', !ok));
        if(!ok) msgs.push('Esfera de Governo');
      }
      if (s===3) {
        // 3.2: precisa escolher uma opção (radio)
        const rOK = $('#em_adm')?.checked || $('#em_jud')?.checked;
        if (!rOK) msgs.push('Tipo de emissão do último CRP (item 3.2)');
        // 3.3: precisa marcar ao menos um critério
        const cOK = hasAnyChecked('input[name="CRITERIOS_IRREGULARES[]"]');
        if (!cOK) msgs.push('Critérios irregulares (item 3.3)');
      }
    }

    // --- Passo 4: cada subitem precisa de pelo menos 1 marcado ---
    if (s === 4) {
      // 4.1
      const g41 = ['#parc60', '#parc300'];
      const ok41 = g41.some(sel => $(sel)?.checked);
      g41.forEach(sel => $(sel)?.classList.toggle('is-invalid', !ok41));
      if (!ok41) msgs.push('Marque ao menos uma opção no item 4.1 (parcelamento).');

      // 4.2
      const g42 = ['#reg_sem_jud', '#reg_com_jud'];
      const ok42 = g42.some(sel => $(sel)?.checked);
      g42.forEach(sel => $(sel)?.classList.toggle('is-invalid', !ok42));
      if (!ok42) msgs.push('Marque ao menos uma opção no item 4.2 (regularização para CRP).');

      // 4.3
      const g43 = ['#eq_implano', '#eq_prazos', '#eq_plano_alt'];
      const ok43 = g43.some(sel => $(sel)?.checked);
      g43.forEach(sel => $(sel)?.classList.toggle('is-invalid', !ok43));
      if (!ok43) msgs.push('Marque ao menos uma opção no item 4.3 (equacionamento do déficit atuarial).');

      // 4.4
      const g44 = ['#org_ugu', '#org_outros'];
      const ok44 = g44.some(sel => $(sel)?.checked);
      g44.forEach(sel => $(sel)?.classList.toggle('is-invalid', !ok44));
      if (!ok44) msgs.push('Marque ao menos uma opção no item 4.4 (critérios estruturantes).');

      // 4.5
      const g45 = ['#man_cert', '#man_melhoria', '#man_acomp'];
      const ok45 = g45.some(sel => $(sel)?.checked);
      g45.forEach(sel => $(sel)?.classList.toggle('is-invalid', !ok45));
      if (!ok45) msgs.push('Marque ao menos uma opção no item 4.5 (fase de manutenção da conformidade).');
    }


    // Passo 5: TODOS os itens obrigatórios
    if (s===5){
      const all = $$('.grp-comp');
      const checked = all.filter(i=>i.checked);
      if (checked.length !== all.length) msgs.push('No item 5, marque todas as declarações de compromisso.');
    }

    if (s===6 && !hasAnyChecked('.grp-prov')) msgs.push('Marque ao menos uma providência (item 6).');
    if (s===7 && !$('#DECL_CIENCIA').checked) msgs.push('Confirme a ciência das condições (item 7).');

    if (msgs.length){ showAtencao(msgs); return false; }
    return true;
  }

  btnNext?.addEventListener('click', ()=>{
    if (step===0 && !cnpjOK) { showAtencao(['Pesquise e selecione um CNPJ válido antes de prosseguir.']); return; }
    if (!validateStep(step)) return;
    showStep(step+1);
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
    'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
    'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
    'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG',
    'DATA_VENCIMENTO_ULTIMO_CRP','EMAIL_ENTE','EMAIL_UG'
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
      await fetch(`${API_BASE}/api/upsert-cnpj`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      }).catch(()=>{ /* não bloqueia */ });
    }
  }

  /* ========= Busca por CNPJ ========= */
  $('#btnPesquisar')?.addEventListener('click', async ()=>{
    const cnpj = digits($('#CNPJ_ENTE_PESQ').value||'');
    if(cnpj.length!==14) { 
      const el = $('#CNPJ_ENTE_PESQ'); el.classList.add('is-invalid');
      return showAtencao(['Informe um CNPJ válido.']); 
    }

    try{
      modalLoadingSearch.show();
      const r = await fetch(`${API_BASE}/api/consulta?cnpj=${cnpj}`);
      if(!r.ok){
        modalLoadingSearch.hide();
        // permitir prosseguir preenchendo manualmente
        showAtencao([
          'CNPJ não encontrado no CADPREV.',
          'Preencha os dados do Ente/UG na Etapa 1 e eles serão cadastrados.'
        ]);
        cnpjOK = true; cnpjMissing = true;
        // pré-preenche CNPJ do ente para ajudar
        $('#CNPJ_ENTE').value = maskCNPJ(cnpj);
        showStep(1);
        updateNavButtons(); updateFooterAlign();
        return;
      }
      const { data } = await r.json();

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
      showStep(1);
    }catch{
      showErro(['Falha ao consultar o CNPJ.']);
      cnpjOK = false; updateNavButtons(); updateFooterAlign();
    }finally{
      modalLoadingSearch.hide();
    }
  });

  /* ========= Busca reps por CPF ========= */
  async function buscarRepByCPF(cpf, target){
    const cpfd = digits(cpf||'');
    if(cpfd.length!==11) { showAtencao(['Informe um CPF válido.']); return; }
    try{
      modalLoadingSearch.show();
      const r = await fetch(`${API_BASE}/api/rep-by-cpf?cpf=${cpfd}`);
      if(!r.ok){
        modalLoadingSearch.hide();
        // mantém CPF e permite digitar demais dados manualmente
        showAtencao(['Registro não encontrado no CADPREV, favor inserir seus dados.']);
        if (target==='ENTE'){ $('#NOME_REP_ENTE')?.focus(); }
        else { $('#NOME_REP_UG')?.focus(); }
        return; // mantém o CPF e campos vazios para digitação
      }
      const { data } = await r.json();
      if(target==='ENTE'){
        $('#NOME_REP_ENTE').value = data.NOME || '';
        $('#CARGO_REP_ENTE').value = data.CARGO || '';
        $('#EMAIL_REP_ENTE').value = data.EMAIL || '';
        $('#TEL_REP_ENTE').value   = data.TELEFONE || '';
      }else{
        $('#NOME_REP_UG').value = data.NOME || '';
        $('#CARGO_REP_UG').value = data.CARGO || '';
        $('#EMAIL_REP_UG').value = data.EMAIL || '';
        $('#TEL_REP_UG').value   = data.TELEFONE || '';
      }
    }catch{
      showErro(['Falha ao consultar CPF.']);
    }finally{
      modalLoadingSearch.hide();
    }
  }

  $('#btnPesqRepEnte')?.addEventListener('click', ()=> buscarRepByCPF($('#CPF_REP_ENTE').value,'ENTE'));
  $('#btnPesqRepUg')?.addEventListener('click',   ()=> buscarRepByCPF($('#CPF_REP_UG').value,'UG'));

  async function upsertRepresentantes(){
    const base = {
      UF: $('#UF').value.trim(),
      ENTE: $('#ENTE').value.trim(),
      UG: $('#UG').value.trim(),
    };
    const reps = [
      { ...base, NOME: $('#NOME_REP_ENTE').value.trim(), CPF: digits($('#CPF_REP_ENTE').value),
        EMAIL: $('#EMAIL_REP_ENTE').value.trim(), TELEFONE: $('#TEL_REP_ENTE').value.trim(), CARGO: $('#CARGO_REP_ENTE').value.trim(),
        // para o representante do ENTE, gravar UG vazio para padronizar busca futura
        UG: '' },
      { ...base, NOME: $('#NOME_REP_UG').value.trim(), CPF: digits($('#CPF_REP_UG').value),
        EMAIL: $('#EMAIL_REP_UG').value.trim(), TELEFONE: $('#TEL_REP_UG').value.trim(), CARGO: $('#CARGO_REP_UG').value.trim() }
    ];
    for (const rep of reps){
      // grava se tem CPF válido e pelo menos nome preenchido
      if (digits(rep.CPF).length===11 && rep.NOME){
        await fetch(`${API_BASE}/api/upsert-rep`, {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rep)
        }).catch(()=>{ /* silencioso: não bloqueia o envio do termo */ });
      }
    }
  }

  /* ========= Submit ========= */
  $('#regularidadeForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    for (let s=1; s<=8; s++){ if(!validateStep(s)) return; }

    await upsertBaseIfMissing();
    await upsertRepresentantes();

    const now = new Date();
    $('#MES').value               = String(now.getMonth()+1).padStart(2,'0');
    $('#DATA_TERMO_GERADO').value = fmtBR(now);
    $('#HORA_TERMO_GERADO').value = fmtHR(now);
    $('#ANO_TERMO_GERADO').value  = String(now.getFullYear());

    const payload = {
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
      CONDICAO_VIGENCIA: $('#DECL_CIENCIA').checked ? 'Declaro ciência das condições' : '',
      MES: $('#MES').value,
      DATA_TERMO_GERADO: $('#DATA_TERMO_GERADO').value,
      HORA_TERMO_GERADO: $('#HORA_TERMO_GERADO').value,
      ANO_TERMO_GERADO: $('#ANO_TERMO_GERADO').value,
      __snapshot_base: snapshotBase,
      __user_changed_fields: Array.from(editedFields)
    };

    const submitOriginalHTML = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = 'Gerando Formulário…';

    try{
      const res = await fetch(`${API_BASE}/api/gerar-termo`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const err = await res.json().catch(()=>({error:'Erro ao salvar.'}));
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = submitOriginalHTML;
        return showErro([err.error || 'Falha ao registrar termo.']);
      }

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
        auto: '1'
      });
      payload.CRITERIOS_IRREGULARES.forEach((c, i) => qs.append(`criterio${i+1}`, c));

      window.open(`termo.html?${qs.toString()}`, '_blank', 'noopener');

      modalSucesso.show();
      setTimeout(() => {
        modalSucesso.hide();
        $('#regularidadeForm').reset();
        $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
        $$( 'input[type="checkbox"], input[type="radio"]' ).forEach(el=> el.checked=false);
        editedFields.clear();
        snapshotBase = null;
        cnpjOK = false;
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = submitOriginalHTML;
        showStep(0);
      }, 5000);

    }catch{
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = submitOriginalHTML;
      showErro(['Falha de comunicação com o servidor.']);
    }
  });
})();
