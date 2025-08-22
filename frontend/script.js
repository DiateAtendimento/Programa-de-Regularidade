// script.js — Multi-etapas com: máscaras, stepper, busca nas abas, loading, edição com ✎, confirmação de alterações e submissão
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

  // cria modal genérico se não existir
  function ensureModal(id, {title='', bodyHTML='', backdrop='static', keyboard=false, size=''} = {}){
    if ($(id)) return $(id);
    const wrap = document.createElement('div');
    wrap.className='modal fade';
    wrap.id = id.replace('#','');
    wrap.tabIndex = -1;
    wrap.innerHTML = `
      <div class="modal-dialog ${size}">
        <div class="modal-content border-0 shadow">
          <div class="modal-header">
            <h5 class="modal-title">${title}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">${bodyHTML}</div>
          <div class="modal-footer d-none"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const m = new bootstrap.Modal(wrap, { backdrop, keyboard });
    // fixa cabeçalho conforme contexto
    return $(id);
  }

  // Modais fixos existentes
  const modalErro    = new bootstrap.Modal($('#modalErro'));
  const modalBusca   = new bootstrap.Modal($('#modalBusca'));
  const modalSucesso = new bootstrap.Modal($('#modalSucesso'));

  // Modal "Carregando…"
  ensureModal('#modalLoading',{
    title:'Carregando informações',
    bodyHTML:'<div class="d-flex align-items-center gap-3"><div class="spinner-border" role="status"></div><div>Consultando a base…</div></div>',
    backdrop:'static', keyboard:false, size:'modal-sm'
  });
  const modalLoading = new bootstrap.Modal($('#modalLoading'), {backdrop:'static', keyboard:false});

  // Modal de confirmação de alterações
  ensureModal('#modalConfirm',{
    title:'Confirmar alterações',
    bodyHTML:'<div id="confirmChangesList" class="small"></div>',
    backdrop:'static', keyboard:false
  });
  const modalConfirmEl = $('#modalConfirm');
  const confirmFooter = modalConfirmEl.querySelector('.modal-footer');
  confirmFooter.classList.remove('d-none');
  confirmFooter.innerHTML = `
    <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
    <button type="button" id="btnConfirmProceed" class="btn btn-primary">Confirmar e continuar</button>
  `;
  const modalConfirm = new bootstrap.Modal(modalConfirmEl);

  function showErro(msgs){
    const ul = $('#modalErroLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
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

  // Telefones
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
  let step = 0;                 // 0..6
  let cnpjOK = false;           // libera “Próximo” na etapa 0
  let awaitingConfirm = null;   // cache do que está em confirmação

  const sections = $$('[data-step]');
  const stepsUI  = $$('#stepper .step');
  const btnPrev  = $('#btnPrev');
  const btnNext  = $('#btnNext');
  const btnSubmit= $('#btnSubmit');

  function updateNavButtons(){
    // mostrar/ocultar "Voltar"
    if (step >= 2) {
      btnPrev.classList.remove('invisible'); btnPrev.classList.remove('d-none');
    } else {
      btnPrev.classList.add('d-none');
    }
    // habilitar/desabilitar "Próximo"
    if (step === 0) {
      btnNext.disabled = !cnpjOK;
    } else {
      btnNext.disabled = false;
    }
    // alterna Next/Submit na última etapa
    btnNext.classList.toggle('d-none', step===6);
    btnSubmit.classList.toggle('d-none', step!==6);
  }

  function showStep(n){
    step = Math.max(0, Math.min(6, n));
    sections.forEach(sec => sec.style.display = (Number(sec.dataset.step)===step ? '' : 'none'));
    stepsUI.forEach((s,i)=> s.classList.toggle('active', i===step));
    updateNavButtons();
  }
  showStep(0);

  btnPrev?.addEventListener('click', ()=> showStep(step-1));

  btnNext?.addEventListener('click', async ()=>{
    // Etapa 0: só avança se CNPJ foi encontrado
    if (step === 0 && !cnpjOK) {
      return showErro(['Pesquise e selecione um CNPJ válido antes de prosseguir.']);
    }

    // Etapas 1 e 2: se houve alterações em campos auto-preenchidos, pedir confirmação
    if (step === 1 || step === 2) {
      const changes = listChangedAuto(step);
      if (changes.length) {
        const ul = document.createElement('ul');
        ul.className = 'mb-0';
        changes.forEach(ch => {
          const li = document.createElement('li');
          li.innerHTML = `<strong>${ch.label}:</strong> “${ch.before}” → “${ch.after}”`;
          ul.appendChild(li);
        });
        $('#confirmChangesList').innerHTML = '';
        $('#confirmChangesList').appendChild(ul);
        awaitingConfirm = { nextStep: step+1 };
        modalConfirm.show();
        return; // aguarda clique em "Confirmar"
      }
    }

    // Etapas com validação “forte”: 1..3
    if (step>=1 && step<=3) {
      if (!validateStep(step)) return;
    }

    showStep(step+1);
  });

  // "Confirmar e continuar" do modal de alterações
  $('#btnConfirmProceed')?.addEventListener('click', ()=>{
    modalConfirm.hide();
    if (awaitingConfirm && Number.isInteger(awaitingConfirm.nextStep)) {
      showStep(awaitingConfirm.nextStep);
    }
    awaitingConfirm = null;
  });

  /* ========= Esfera (apenas 1) ========= */
  $$('.esf-only-one').forEach(chk=>{
    chk.addEventListener('change', ()=>{
      if(chk.checked){
        $$('.esf-only-one').forEach(o=>{ if(o!==chk) o.checked=false; });
        markValid(chk);
      } else {
        neutral(chk);
      }
    });
  });
  function autoselectEsferaByEnte(ente){
    const estadual = rmAcc(ente).includes('governo do estado');
    const chkEst = $('#esf_est'), chkMun = $('#esf_mun');
    if (chkEst && chkMun) {
      chkEst.checked = estadual;
      chkMun.checked = !estadual;
      [chkEst,chkMun].forEach(neutral);
      markValid(estadual?chkEst:chkMun);
    }
  }

  /* ========= Validações por etapa (foco 1..3) ========= */
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
    3: [
      {id:'DATA_VENCIMENTO_ULTIMO_CRP', type:'date', label:'Data do último CRP'},
      // Tipos (rádio) não são obrigatórios aqui porque o backend decide por “Sim/Não” vindo da aba CRP
    ]
  };
  function checkField(id,type){
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
  }
  function validateStep(s){
    const msgs=[];
    (reqAll[s]||[]).forEach(o => { if(!checkField(o.id,o.type)) msgs.push(o.label); });
    if (s===1) {
      const items = $$('input[name="ESFERA_GOVERNO[]"]');
      const ok = items.some(i=>i.checked);
      items.forEach(i => i.classList.toggle('is-invalid', !ok));
      if(!ok) msgs.push('Esfera de Governo');
    }
    if (msgs.length){ showErro(msgs); return false; }
    return true;
  }

  /* ========= Snapshot base + campos auto (para confirmação) ========= */
  let snapshotBase = null;
  const autoFields = [
    // Etapa 1
    {id:'UF', label:'UF', norm:v=>String(v||'').trim()},
    {id:'ENTE', label:'Ente', norm:v=>String(v||'').trim()},
    {id:'CNPJ_ENTE', label:'CNPJ do Ente', norm:v=>digits(v)},
    {id:'UG', label:'UG', norm:v=>String(v||'').trim()},
    {id:'CNPJ_UG', label:'CNPJ da UG', norm:v=>digits(v)},
    // Etapa 2 — Representantes
    {id:'CPF_REP_ENTE', label:'CPF do Rep. do Ente', norm:v=>digits(v)},
    {id:'NOME_REP_ENTE', label:'Nome do Rep. do Ente', norm:v=>String(v||'').trim()},
    {id:'CARGO_REP_ENTE', label:'Cargo do Rep. do Ente', norm:v=>String(v||'').trim()},
    {id:'EMAIL_REP_ENTE', label:'E-mail do Rep. do Ente', norm:v=>String(v||'').trim()},
    {id:'TEL_REP_ENTE', label:'Telefone do Rep. do Ente', norm:v=>digits(v)},
    {id:'CPF_REP_UG', label:'CPF do Rep. da UG', norm:v=>digits(v)},
    {id:'NOME_REP_UG', label:'Nome do Rep. da UG', norm:v=>String(v||'').trim()},
    {id:'CARGO_REP_UG', label:'Cargo do Rep. da UG', norm:v=>String(v||'').trim()},
    {id:'EMAIL_REP_UG', label:'E-mail do Rep. da UG', norm:v=>String(v||'').trim()},
    {id:'TEL_REP_UG', label:'Telefone do Rep. da UG', norm:v=>digits(v)},
  ];
  let autoSnapshotCompare = {}; // {id: valorNormalizado}
  function buildAutoSnapshotCompare(from){
    autoSnapshotCompare = {
      UF: from?.UF || '',
      ENTE: from?.ENTE || '',
      CNPJ_ENTE: from?.CNPJ_ENTE || '',
      UG: from?.UG || '',
      CNPJ_UG: from?.CNPJ_UG || '',
      NOME_REP_ENTE: from?.NOME_REP_ENTE || '',
      CPF_REP_ENTE: from?.CPF_REP_ENTE || '',
      TEL_REP_ENTE: from?.TEL_REP_ENTE || '',
      EMAIL_REP_ENTE: from?.EMAIL_REP_ENTE || '',
      CARGO_REP_ENTE: from?.CARGO_REP_ENTE || '',
      NOME_REP_UG: from?.NOME_REP_UG || '',
      CPF_REP_UG: from?.CPF_REP_UG || '',
      TEL_REP_UG: from?.TEL_REP_UG || '',
      EMAIL_REP_UG: from?.EMAIL_REP_UG || '',
      CARGO_REP_UG: from?.CARGO_REP_UG || ''
    };
    // normaliza para comparação
    for (const f of autoFields) {
      autoSnapshotCompare[f.id] = f.norm(autoSnapshotCompare[f.id] || '');
    }
  }

  // “Travar” campos auto-preenchidos e adicionar botão ✎
  function decorateAutoFields(){
    autoFields.forEach(({id})=>{
      const el = document.getElementById(id);
      if (!el) return;
      // evita duplicar decoração
      if (el.dataset.decorated === '1') return;
      el.dataset.decorated = '1';

      el.readOnly = true;
      el.classList.add('bg-light'); // aparência de bloqueado

      // cria botão ✎ ao lado
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm btn-outline-secondary ms-2';
      btn.textContent = '✎';
      btn.title = 'Permitir edição deste campo';
      // insere após o input
      el.insertAdjacentElement('afterend', btn);
      btn.addEventListener('click', ()=>{
        el.readOnly = !el.readOnly;
        btn.classList.toggle('btn-outline-secondary', el.readOnly);
        btn.classList.toggle('btn-warning', !el.readOnly);
        btn.title = el.readOnly ? 'Permitir edição deste campo' : 'Bloquear edição deste campo';
        if (!el.readOnly) el.focus();
      });
    });
  }

  // Lista alterações nos campos auto da etapa atual (1: identificação; 2: responsáveis)
  function listChangedAuto(currentStep){
    const idsByStep = currentStep===1
      ? ['UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG']
      : currentStep===2
        ? ['CPF_REP_ENTE','NOME_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE','CPF_REP_UG','NOME_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG']
        : [];
    const changes = [];
    idsByStep.forEach(id=>{
      const def = autoFields.find(f=>f.id===id);
      if(!def) return;
      const before = autoSnapshotCompare[id] || '';
      const after  = def.norm($('#'+id).value || '');
      if (String(before) !== String(after)) {
        // monta a versão "bonita" para exibir (com máscara, quando couber)
        const prettyBefore = (id.includes('CNPJ') ? maskCNPJ(before) :
                             id.includes('CPF')  ? maskCPF(before)  :
                             id.includes('TEL')  ? maskPhone(before) : before);
        const prettyAfter  = (id.includes('CNPJ') ? maskCNPJ(after) :
                             id.includes('CPF')  ? maskCPF(after)  :
                             id.includes('TEL')  ? maskPhone(after) : after);
        changes.push({ id, label:def.label, before:prettyBefore, after:prettyAfter });
      }
    });
    return changes;
  }

  /* ========= Busca por CNPJ (consulta unificada) ========= */
  $('#btnPesquisar')?.addEventListener('click', async ()=>{
    const cnpj = digits($('#CNPJ_ENTE_PESQ').value||'');
    if(cnpj.length!==14) { markInvalid($('#CNPJ_ENTE_PESQ')); return showErro(['Informe um CNPJ válido.']); }
    markValid($('#CNPJ_ENTE_PESQ'));

    try{
      modalLoading.show();
      const r = await fetch(`${API_BASE}/api/consulta?cnpj=${cnpj}`);
      if(!r.ok){ modalLoading.hide(); modalBusca.show(); cnpjOK = false; updateNavButtons(); return; }
      const { data } = await r.json();
      snapshotBase = data.__snapshot || null;

      // Preenche etapa 1
      $('#UF').value = data.UF || '';
      $('#ENTE').value = data.ENTE || '';
      $('#CNPJ_ENTE').value = maskCNPJ(data.CNPJ_ENTE || '');
      $('#UG').value = data.UG || '';
      $('#CNPJ_UG').value = maskCNPJ(data.CNPJ_UG || '');

      // Reps
      $('#NOME_REP_ENTE').value = data.NOME_REP_ENTE || '';
      $('#CPF_REP_ENTE').value  = maskCPF(data.CPF_REP_ENTE || '');
      $('#EMAIL_REP_ENTE').value= data.EMAIL_REP_ENTE || '';
      $('#TEL_REP_ENTE').value  = data.TEL_REP_ENTE || '';
      $('#CARGO_REP_ENTE').value= data.CARGO_REP_ENTE || '';

      $('#NOME_REP_UG').value = data.NOME_REP_UG || '';
      $('#CPF_REP_UG').value  = maskCPF(data.CPF_REP_UG || '');
      $('#EMAIL_REP_UG').value= data.EMAIL_REP_UG || '';
      $('#TEL_REP_UG').value  = data.TEL_REP_UG || '';
      $('#CARGO_REP_UG').value= data.CARGO_REP_UG || '';

      // CRP (etapa 3)
      if(data.CRP_DATA_VALIDADE) $('#DATA_VENCIMENTO_ULTIMO_CRP').value = data.CRP_DATA_VALIDADE;
      const dj = rmAcc(String(data.CRP_DECISAO_JUDICIAL || ''));
      if (dj === 'nao') $('#em_adm').checked = true;
      else if (dj === 'sim') $('#em_jud').checked = true;

      // Esfera (1.1)
      autoselectEsferaByEnte(data.ENTE);

      // Valida visualmente
      Object.values(reqAll).flat().forEach(({id,type})=> checkField(id,type));

      // “Trava” campos e adiciona ✎
      decorateAutoFields();
      // Prepara snapshot para comparação de mudanças
      buildAutoSnapshotCompare({
        UF: data.UF, ENTE: data.ENTE, CNPJ_ENTE: data.CNPJ_ENTE, UG: data.UG, CNPJ_UG: data.CNPJ_UG,
        NOME_REP_ENTE: data.NOME_REP_ENTE, CPF_REP_ENTE: data.CPF_REP_ENTE, TEL_REP_ENTE: data.TEL_REP_ENTE,
        EMAIL_REP_ENTE: data.EMAIL_REP_ENTE, CARGO_REP_ENTE: data.CARGO_REP_ENTE,
        NOME_REP_UG: data.NOME_REP_UG, CPF_REP_UG: data.CPF_REP_UG, TEL_REP_UG: data.TEL_REP_UG,
        EMAIL_REP_UG: data.EMAIL_REP_UG, CARGO_REP_UG: data.CARGO_REP_UG
      });

      cnpjOK = true;
      modalLoading.hide();
      showStep(1);
    }catch{
      modalLoading.hide();
      modalBusca.show();
      cnpjOK = false; updateNavButtons();
    }
  });

  // Busca reps por CPF (auxiliar, sem travar avanço das etapas)
  async function buscarRepByCPF(cpf, fillPrefix){
    const cpfd = digits(cpf||'');
    if(cpfd.length!==11) { showErro(['Informe um CPF válido.']); return; }
    try{
      modalLoading.show();
      const r = await fetch(`${API_BASE}/api/rep-by-cpf?cpf=${cpfd}`);
      modalLoading.hide();
      if(!r.ok){ modalBusca.show(); return; }
      const { data } = await r.json();
      if(fillPrefix==='ENTE'){
        $('#NOME_REP_ENTE').value = data.NOME || '';
        $('#CARGO_REP_ENTE').value = data.CARGO || '';
        $('#EMAIL_REP_ENTE').value = data.EMAIL || '';
        $('#TEL_REP_ENTE').value = data.TELEFONE || '';
      }else{
        $('#NOME_REP_UG').value = data.NOME || '';
        $('#CARGO_REP_UG').value = data.CARGO || '';
        $('#EMAIL_REP_UG').value = data.EMAIL || '';
        $('#TEL_REP_UG').value = data.TELEFONE || '';
      }
    }catch{
      modalLoading.hide();
      showErro(['Falha ao consultar CPF.']);
    }
  }
  $('#btnPesqRepEnte')?.addEventListener('click', ()=> buscarRepByCPF($('#CPF_REP_ENTE').value,'ENTE'));
  $('#btnPesqRepUg')?.addEventListener('click',   ()=> buscarRepByCPF($('#CPF_REP_UG').value,'UG'));

  /* ========= Submit ========= */
  $('#regularidadeForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    // valida minimamente até a etapa 3
    if(!validateStep(1) || !validateStep(2) || !validateStep(3)) return;

    // carimbos
    const now = new Date();
    $('#MES').value = String(now.getMonth()+1).padStart(2,'0');
    $('#DATA_TERMO_GERADO').value = fmtBR(now);
    $('#HORA_TERMO_GERADO').value = fmtHR(now);
    $('#ANO_TERMO_GERADO').value = String(now.getFullYear());

    const outroTxt = '';
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
        ($('#em_jud').checked && 'Judicial') ||
        (outroTxt || ''),
      // campos 4..6 são livres; enviamos concatenados
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
      __snapshot_base: snapshotBase || null
    };

    try{
      modalLoading.show();
      const res = await fetch(`${API_BASE}/api/gerar-termo`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      modalLoading.hide();
      if(!res.ok){
        const err = await res.json().catch(()=>({error:'Erro ao salvar.'}));
        return showErro([err.error || 'Falha ao registrar termo.']);
      }

      // Abre termo.html com os dados (auto download)
      const qs = new URLSearchParams({
        uf: payload.UF,
        ente: payload.ENTE,
        cnpj_ente: $('#CNPJ_ENTE').value,
        ug: payload.UG,
        cnpj_ug: $('#CNPJ_UG').value,
        nome_rep_ente: payload.NOME_REP_ENTE,
        cpf_rep_ente: $('#CPF_REP_ENTE').value,
        cargo_rep_ente: payload.CARGO_REP_ENTE,
        email_rep_ente: payload.EMAIL_REP_ENTE,
        nome_rep_ug: payload.NOME_REP_UG,
        cpf_rep_ug: $('#CPF_REP_UG').value,
        cargo_rep_ug: payload.CARGO_REP_UG,
        email_rep_ug: payload.EMAIL_REP_UG,
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
      }).toString();
      window.open(`termo.html?${qs}`, '_blank', 'noopener');

      modalSucesso.show();
    }catch{
      modalLoading.hide();
      showErro(['Falha de comunicação com o servidor.']);
    }
  });
})();
