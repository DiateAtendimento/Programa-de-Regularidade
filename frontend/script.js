// frontend/script.js

document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  const BACKEND      = 'https://programa-de-regularidade.onrender.com';

  // 0) referências para autocomplete de “Ente”
  const ufSelect     = document.getElementById('uf');
  const enteInput    = document.getElementById('ente');
  const datalist     = document.getElementById('entes-list');
  let todasEntradas  = []; // [{ uf: "...", ente: "..." }, ...]

  // 1) carregue a lista Fonte via API
  fetch(`${BACKEND}/api/entes`)
    .then(resp => resp.json())
    .then(lista => {
      todasEntradas = lista;
      atualizarDatalist(); // pré-popula, caso UF já esteja selecionada
    })
    .catch(err => console.error('Erro ao buscar lista de entes:', err));

  // 2) máscara de CNPJ, CPF e Telefone (armazenando as instâncias)
  const cleaveCNPJ = new Cleave('#cnpj', {
    numericOnly: true,
    delimiters: ['.', '.', '/', '-'],
    blocks: [2,3,3,4,2]
  });
  const cleaveCPF = new Cleave('#cpf', {
    numericOnly: true,
    delimiters: ['.', '.', '-'],
    blocks: [3,3,3,2]
  });
  const cleaveTel = new Cleave('#telefone', {
    phone: true,
    phoneRegionCode: 'BR'
  });

  // 3) ao mudar UF, atualiza sugestões de Ente
  ufSelect.addEventListener('change', atualizarDatalist);

  function atualizarDatalist() {
    const ufSel = ufSelect.value;
    const entes = todasEntradas
      .filter(item => item.uf === ufSel)
      .map(item => item.ente)
      .filter((v,i,a) => a.indexOf(v) === i);

    // limpa UL
    datalist.innerHTML = '';

    // popula UL com <li>
    entes.forEach(nome => {
      const li = document.createElement('li');
      li.textContent = nome;
      li.addEventListener('click', () => {
        enteInput.value = nome;
        datalist.innerHTML = '';
      });
      datalist.appendChild(li);
    });
  }

  // 4) repopula dia/mês/ano após reset
  form.addEventListener('reset', () => setTimeout(populaDataSistema, 0));

  // 5) submit
  form.addEventListener('submit', async e => {
    e.preventDefault();
    form.classList.add('was-validated');

    // validações nativas + critérios
    const formValid      = form.checkValidity();
    const criterios      = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(i => i.value);
    const criteriosValid = criterios.length >= 1;

    // valida máscaras usando as instâncias
    const rawCNPJ = cleaveCNPJ.getRawValue();
    const rawCPF  = cleaveCPF.getRawValue();
    const rawTel  = cleaveTel.getRawValue();
    const maskValid = rawCNPJ.length === 14
                   && rawCPF.length  === 11
                   && (rawTel.length === 10 || rawTel.length === 11);

    if (!maskValid) {
      if (rawCNPJ.length !== 14) document.getElementById('cnpj').classList.add('is-invalid');
      if (rawCPF.length  !== 11) document.getElementById('cpf').classList.add('is-invalid');
      if (![10,11].includes(rawTel.length)) document.getElementById('telefone').classList.add('is-invalid');
    }

    critFeedback.style.display = criteriosValid ? 'none' : 'block';
    if (!formValid || !criteriosValid || !maskValid) return;

    // coleta dados do form
    const dados = Object.fromEntries(new FormData(form).entries());

    // monta data e hora do sistema (fuso São Paulo)
    const agora         = new Date();
    const dataSistema   = agora.toLocaleDateString('pt-BR');
    const horaSistema   = agora.toLocaleTimeString('pt-BR', {
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Sao_Paulo'
    });
    const anoSistema    = agora.getFullYear();

    // payload completo
    const sheetPayload = {
      CNPJ:        dados.cnpj,
      UF:          dados.uf,
      ENTE:        dados.ente,
      CPF:         dados.cpf,
      NOME:        dados.nome,
      "CRITÉRIOS": criterios.join(', '),
      TELEFONE:    dados.telefone,
      EMAIL:       dados.email,
      ENDEREÇO:    dados.endereco,
      CIDADE:      dados.cidade,
      DIA:         dados.dia,
      MÊS:         dados.mes,
      ANO:         dados.ano,         // vindo do usuário (readonly)
      DATA:        dataSistema,       // nova coluna
      HORA:        horaSistema,       // nova coluna
      ANO_SISTEMA: anoSistema,        // nova coluna
      RESPONSAVEL: dados.responsavel
    };

    // overlay + loading
    overlay.style.display = 'flex';
    let anim = lottie.loadAnimation({
      container:  lottiePlayer,
      renderer:   'svg',
      loop:       true,
      autoplay:   true,
      path:       '/animacao/confirm-success.json'
    });

    // envia ao backend
    let savedOK = true;
    try {
      const resp = await fetch(`${BACKEND}/api/gerar-termo`, {
        method:  'POST',
        headers: { 'Content-Type':'application/json' },
        body:    JSON.stringify(sheetPayload)
      });
      if (!resp.ok) savedOK = false;
    } catch {
      savedOK = false;
    }

    // resultado
    anim.destroy();
    anim = lottie.loadAnimation({
      container:  lottiePlayer,
      renderer:   'svg',
      loop:       false,
      autoplay:   true,
      path:       savedOK
                ? '/animacao/confirm-success.json'
                : '/animacao/confirm-error.json'
    });

    // final
    setTimeout(() => {
      overlay.style.display = 'none';
      anim.destroy();
      if (savedOK) {
        const qs = new URLSearchParams();
        ['ente','cnpj','uf','cpf','nome','telefone','email','endereco','cidade','dia','mes','ano','responsavel']
          .forEach(k => qs.set(k, dados[k]));
        criterios.forEach(c => qs.append('criterios', c));
        window.open(`termo.html?${qs.toString()}`, '_blank');
        form.reset();
        form.classList.remove('was-validated');
        critFeedback.style.display = 'none';
      } else {
        alert('Erro ao gravar no Google Sheets. Tente novamente.');
      }
    }, 2000);
  });
});

// repopula data do sistema
function populaDataSistema() {
  const hoje = new Date();
  const dia  = String(hoje.getDate()).padStart(2,'0');
  const mes  = hoje.toLocaleString('pt-BR',{ month:'long' });
  const ano  = hoje.getFullYear();
  ['dia','mes','ano'].forEach(id => {
    const el = document.getElementById(id);
    el.value = id === 'mes' ? mes : (id === 'dia' ? dia : ano);
    el.readOnly = true;
  });
}
