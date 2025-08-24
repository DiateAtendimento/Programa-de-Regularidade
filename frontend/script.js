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
  const modalAtencao  = new bootstrap.Modal($('#modalAtencao'));
  const modalErro     = new bootstrap.Modal($('#modalErro'));
  const modalBusca    = new bootstrap.Modal($('#modalBusca'));
  const modalSucesso  = new bootstrap.Modal($('#modalSucesso'));
  const modalLoading  = new bootstrap.Modal($('#modalLoading'), { backdrop:'static', keyboard:false });
  const modalWelcome  = new bootstrap.Modal($('#modalWelcome'));

  // Mostra SEMPRE o modal de boas-vindas ao carregar
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
  $('#modalLoading')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieLoading', 'animacao/carregando-info.json', { loop:true, autoplay:true });
  });
  $('#modalAtencao')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieAtencao', 'animacao/atencao-info.json', { loop:false, autoplay:true });
  });
  $('#modalErro')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieError', 'animacao/confirm-error.json', { loop:false, autoplay:true });
  });
  $('#modalBusca')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieErrorBusca', 'animacao/atencao-info.json', { loop:false, autoplay:true });
  });
  $('#modalSucesso')?.addEventListener('shown.bs.modal', () => {
    mountLottie('lottieSuccess', 'animacao/confirm-success.json', { loop:false, autoplay:true });
  });

  // Atenção (validação/regras não atendidas)
  function showAtencao(msgs){
    const ul = $('#modalAtencaoLista'); ul.innerHTML='';
    msgs.forEach(m=>{ const li=document.createElement('li'); li.textContent=m; ul.appendChild(li); });
    modalAtencao.show();
  }
  // Erro sistêmico
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
  let step = 0;            // 0..7 (0 = tela de pesquisa)
  let cnpjOK = false;

  const sections = $$('[data-step]');
  const stepsUI  = $$('#stepper .step');
  const btnPrev  = $('#btnPrev');
  const btnNext  = $('#btnNext');
  const btnSubmit= $('#btnSubmit');

  function updateNavButtons(){
    btnPrev.classList.toggle('d-none', step < 1);
    btnNext.disabled = (step === 0 && !cnpjOK);
    btnNext.classList.toggle('d-none', step===7);
    btnSubmit.classList.toggle('d-none', step!==7);
  }

  function showStep(n){
    step = Math.max(0, Math.min(7, n));
    sections.forEach(sec => sec.style.display = (Number(sec.dataset.step)===step ? '' : 'none'));
    const activeIdx = Math.min(step, stepsUI.length-1);
    stepsUI.forEach((s,i)=> s.classList.toggle('active', i===activeIdx));
    updateNavButtons();
    // Exibir SEMPRE o modal de boas-vindas quando voltar ao passo 0
    if (step === 0) setTimeout(()=> modalWelcome.show(), 100);
  }
  showStep(0);

  btnPrev?.addEventListener('click', ()=> {
    showStep(step-1);
  });

  // ===== validação de grupos (passos 4–7)
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
    }
    if (s===4 && !hasAnyChecked('.grp-finalidade')) msgs.push('Marque ao menos uma finalidade inicial (item 4).');
    if (s===5 && !hasAnyChecked('.grp-comp'))       msgs.push('Marque ao menos um compromisso (item 5).');
    if (s===6 && !hasAnyChecked('.grp-prov'))       msgs.push('Marque ao menos uma providência (item 6).');
    if (s===7 && !$('#DECL_CIENCIA').checked)       msgs.push('Confirme a ciência das condições (item 7).');

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

  /* ========= Rastreamento de campos digitados ========= */
  const editedFields = new Set();
  const trackIds = [
    'UF','ENTE','CNPJ_ENTE','UG','CNPJ_UG',
    'NOME_REP_ENTE','CPF_REP_ENTE','TEL_REP_ENTE','EMAIL_REP_ENTE','CARGO_REP_ENTE',
    'NOME_REP_UG','CPF_REP_UG','TEL_REP_UG','EMAIL_REP_UG','CARGO_REP_UG',
    'DATA_VENCIMENTO_ULTIMO_CRP'
  ];
  trackIds.forEach(id=>{
    const el = $('#'+id); if(!el) return;
    const ev = (el.tagName==='SELECT' || el.type==='date') ? 'change' : 'input';
    el.addEventListener(ev, ()=> editedFields.add(id));
  });

  // snapshot base (para comparação no log)
  let snapshotBase = null;

  /* ========= Busca por CNPJ ========= */
  $('#btnPesquisar')?.addEventListener('click', async ()=>{
    const cnpj = digits($('#CNPJ_ENTE_PESQ').value||'');
    if(cnpj.length!==14) {
      const el = $('#CNPJ_ENTE_PESQ'); el.classList.add('is-invalid');
      return showAtencao(['Informe um CNPJ válido.']);
    }

    try{
      modalLoading.show();
      const r = await fetch(`${API_BASE}/api/consulta?cnpj=${cnpj}`);
      if(!r.ok){ modalBusca.show(); cnpjOK = false; updateNavButtons(); return; }
      const { data } = await r.json();

      // snapshot
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

      // ETAPA 1
      $('#UF').value = data.UF || '';
      $('#ENTE').value = data.ENTE || '';
      $('#CNPJ_ENTE').value = maskCNPJ(data.CNPJ_ENTE || '');
      $('#UG').value = data.UG || '';
      $('#CNPJ_UG').value = maskCNPJ(data.CNPJ_UG || '');
      $('#EMAIL_ENTE').value = '';
      $('#EMAIL_UG').value = '';

      // limpar reps (pesquisa via CPF)
      ['NOME_REP_ENTE','CPF_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE','CARGO_REP_ENTE',
       'NOME_REP_UG','CPF_REP_UG','EMAIL_REP_UG','TEL_REP_UG','CARGO_REP_UG'
      ].forEach(id=>{ const el = $('#'+id); if(el){ el.value=''; neutral(el); } });

      // CRP
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
      cnpjOK = false; updateNavButtons();
    }finally{
      modalLoading.hide();
    }
  });

  // ========= Busca reps por CPF =========
  async function buscarRepByCPF(cpf, target){
    const cpfd = digits(cpf||'');
    if(cpfd.length!==11) { showAtencao(['Informe um CPF válido.']); return; }
    try{
      modalLoading.show();
      const r = await fetch(`${API_BASE}/api/rep-by-cpf?cpf=${cpfd}`);
      if(!r.ok){ modalBusca.show(); return; }
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
      modalLoading.hide();
    }
  }
  $('#btnPesqRepEnte')?.addEventListener('click', ()=> buscarRepByCPF($('#CPF_REP_ENTE').value,'ENTE'));
  $('#btnPesqRepUg')?.addEventListener('click',   ()=> buscarRepByCPF($('#CPF_REP_UG').value,'UG'));

  /* ========= Submit ========= */
  $('#regularidadeForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    // valida todos os passos (1–7)
    for (let s=1; s<=7; s++){ if(!validateStep(s)) return; }

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

    try{
      modalLoading.show();
      const res = await fetch(`${API_BASE}/api/gerar-termo`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const err = await res.json().catch(()=>({error:'Erro ao salvar.'}));
        return showErro([err.error || 'Falha ao registrar termo.']);
      }

      // abre o termo (termo.html)
      const qs = new URLSearchParams({
        uf: payload.UF, ente: payload.ENTE, cnpj_ente: $('#CNPJ_ENTE').value,
        ug: payload.UG, cnpj_ug: $('#CNPJ_UG').value,
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
      }).toString();
      window.open(`termo.html?${qs}`, '_blank', 'noopener');

      // mostra sucesso e só então volta ao início após 5s
      modalSucesso.show();

      setTimeout(() => {
        try { modalSucesso.hide(); } catch(_) {}
        // reset e volta ao início (reabre o aviso)
        $('#regularidadeForm').reset();
        $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
        $$( 'input[type="checkbox"], input[type="radio"]' ).forEach(el=> el.checked=false);
        editedFields.clear();
        snapshotBase = null;
        cnpjOK = false;
        showStep(0);
      }, 5000);

    }catch{
      showErro(['Falha de comunicação com o servidor.']);
    }finally{
      modalLoading.hide();
    }
  });
})();
