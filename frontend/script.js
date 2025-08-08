document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  const BACKEND      = 'https://programa-de-regularidade.onrender.com';

  // referências para autocomplete de “Ente”
  const ufSelect     = document.getElementById('uf');
  const enteInput    = document.getElementById('ente');
  const ulList       = document.getElementById('entes-list');
  const cidadeInput  = document.getElementById('cidade');
  const responsavel  = document.getElementById('responsavel');
  let todasEntradas  = [];

  // instâncias Cleave
  const cleaveCNPJ = new Cleave('#cnpj',{ numericOnly:true, delimiters:['.','.','/','-'], blocks:[2,3,3,4,2] });
  const cleaveCPF  = new Cleave('#cpf',{ numericOnly:true, delimiters:['.','.','-'], blocks:[3,3,3,2] });
  const cleaveTel  = new Cleave('#telefone',{ phone:true, phoneRegionCode:'BR' });

  // 1) busca lista de entes
  fetch(`${BACKEND}/api/entes`)
    .then(res => res.json())
    .then(lista => {
      todasEntradas = lista;
      atualizarDatalist();
    })
    .catch(err => console.error('Erro ao buscar lista de entes:', err));

  // 2) ao mudar UF ou digitar no Ente
  ufSelect.addEventListener('change', () => {
    atualizarDatalist();
    preencherCidade();
  });
  enteInput.addEventListener('input', () => {
    ulList.style.display = 'block';
    atualizarDatalist();
  });

  // 3) preencher automaticamente "Cidade"
  function preencherCidade(){
    if (ufSelect.value && enteInput.value) {
      cidadeInput.value = `${enteInput.value}/${ufSelect.value}`;
    }
  }
  enteInput.addEventListener('change', preencherCidade);

  // 4) monta lista UL
  function atualizarDatalist(){
    ulList.innerHTML = '';
    const ufSel = ufSelect.value;
    if (!ufSel) { ulList.style.display = 'none'; return; }
    const entes = todasEntradas
      .filter(i=>i.uf===ufSel)
      .map(i=>i.ente)
      .filter((v,i,a)=>a.indexOf(v)===i);

    entes.forEach(nome=>{
      const li = document.createElement('li');
      li.textContent = nome;
      li.addEventListener('click', ()=>{
        enteInput.value = nome;
        ulList.style.display = 'none';
        preencherCidade();
      });
      ulList.appendChild(li);
    });
    ulList.style.display = entes.length? 'block':'none';
  }

  // 5) fecha dropdown ao clicar fora
  document.addEventListener('click', e=>{
    if (!e.target.closest('.position-relative')) {
      ulList.style.display = 'none';
    }
  });

  // 6) pré-preenche responsável com nome
  document.getElementById('nome').addEventListener('input', e=>{
    responsavel.value = e.target.value;
  });

  // 7) repopula data após reset
  form.addEventListener('reset', ()=> setTimeout(populaDataSistema, 0));

  // 8) submit
  form.addEventListener('submit', async e=>{
    e.preventDefault();
    form.classList.add('was-validated');

    const formValid      = form.checkValidity();
    const criterios      = Array.from(form.querySelectorAll('input[name="criterios"]:checked')).map(i=>i.value);
    const criteriosValid = criterios.length >=1;
    const rawCNPJ        = cleaveCNPJ.getRawValue();
    const rawCPF         = cleaveCPF.getRawValue();
    const rawTel         = cleaveTel.getRawValue();
    const maskValid      = rawCNPJ.length===14 && rawCPF.length===11 && (rawTel.length===10||rawTel.length===11);

    if (!maskValid) {
      if (rawCNPJ.length!==14) document.getElementById('cnpj').classList.add('is-invalid');
      if (rawCPF.length !==11) document.getElementById('cpf').classList.add('is-invalid');
      if (![10,11].includes(rawTel.length)) document.getElementById('telefone').classList.add('is-invalid');
    }
    critFeedback.style.display = criteriosValid? 'none':'block';
    if (!formValid || !criteriosValid || !maskValid) return;

    const dados = Object.fromEntries(new FormData(form).entries());
    const agora = new Date();
    const dataSistema = agora.toLocaleDateString('pt-BR');
    const horaSistema = agora.toLocaleTimeString('pt-BR',{ hour:'2-digit',minute:'2-digit',hour12:false, timeZone:'America/Sao_Paulo' });
    const anoSistema  = agora.getFullYear();

    const sheetPayload = {
      CNPJ:        dados.cnpj,
      UF:          dados.uf,
      ENTE:        dados.ente,
      CARGO:       dados.cargo,
      CPF:         dados.cpf,
      NOME:        dados.nome,
      "CRITÉRIOS": criterios.join(', '),
      TELEFONE:    dados.telefone,
      EMAIL:       dados.email,
      ENDEREÇO:    dados.endereco,
      CIDADE:      dados.cidade,
      DIA:         dados.dia,
      MÊS:         dados.mes,
      ANO:         dados.ano,
      DATA:        dataSistema,
      HORA:        horaSistema,
      ANO_SISTEMA: anoSistema,
      RESPONSAVEL: dados.responsavel
    };

    overlay.style.display = 'flex';
    let anim = lottie.loadAnimation({ container:lottiePlayer, renderer:'svg', loop:true, autoplay:true, path:'/animacao/confirm-success.json' });

    let savedOK = true;
    try {
      const resp = await fetch(`${BACKEND}/api/gerar-termo`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(sheetPayload)
      });
      if (!resp.ok) savedOK = false;
    } catch { savedOK = false; }

    anim.destroy();
    anim = lottie.loadAnimation({
      container:lottiePlayer, renderer:'svg', loop:false, autoplay:true,
      path: savedOK? '/animacao/confirm-success.json': '/animacao/confirm-error.json'
    });

    setTimeout(()=>{
      overlay.style.display = 'none';
      anim.destroy();
      if (savedOK) {
        const qs = new URLSearchParams();
        ['cnpj','uf','ente','cargo','cpf','nome','telefone','email','endereco','cidade','dia','mes','ano','responsavel']
          .forEach(k=>qs.set(k, dados[k]));
        criterios.forEach(c=>qs.append('criterios', c));
        window.open(`termo.html?${qs}`, '_blank');
        form.reset(); form.classList.remove('was-validated'); critFeedback.style.display='none';
      } else {
        alert('Erro ao gravar no Google Sheets. Tente novamente.');
      }
    }, 2000);
  });
});

function populaDataSistema(){
  const hoje = new Date();
  const dia  = String(hoje.getDate()).padStart(2,'0');
  const mes  = hoje.toLocaleString('pt-BR',{ month:'long' });
  const ano  = hoje.getFullYear();
  ['dia','mes','ano'].forEach(id=>{
    const el = document.getElementById(id);
    el.value = id==='mes'? mes : (id==='dia'? dia : ano);
    el.readOnly = true;
  });
}
