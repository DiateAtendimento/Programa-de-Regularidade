// frontend/script.js
document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  const BACKEND      = 'https://programa-de-regularidade.onrender.com';

  // 1) inicializa máscaras e guarda instâncias
  const cleaveCNPJ = new Cleave('#cnpj', {
    numericOnly: true,
    delimiters: ['.', '.', '/', '-'],
    blocks: [2, 3, 3, 4, 2]
  });
  const cleaveCPF = new Cleave('#cpf', {
    numericOnly: true,
    delimiters: ['.', '.', '-'],
    blocks: [3, 3, 3, 2]
  });
  const cleaveTel = new Cleave('#telefone', {
    phone: true,
    phoneRegionCode: 'BR'
  });

  // 2) repopula dia/mês/ano após reset
  form.addEventListener('reset', () => setTimeout(populaDataSistema, 0));

  // 3) submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');

    // 3.1 validações nativas + critérios
    const formValid = form.checkValidity();
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;

    // 3.2 verifica comprimento puro das máscaras
    const rawCNPJ = cleaveCNPJ.getRawValue();
    const rawCPF  = cleaveCPF.getRawValue();
    const rawTel  = cleaveTel.getRawValue();
    const maskValid =
      rawCNPJ.length === 14 &&
      rawCPF.length === 11 &&
      (rawTel.length === 10 || rawTel.length === 11);

    if (!maskValid) {
      if (rawCNPJ.length !== 14) document.getElementById('cnpj').classList.add('is-invalid');
      if (rawCPF.length  !== 11) document.getElementById('cpf').classList.add('is-invalid');
      if (![10,11].includes(rawTel.length)) document.getElementById('telefone').classList.add('is-invalid');
    }

    critFeedback.style.display = criteriosValid ? 'none' : 'block';
    if (!formValid || !criteriosValid || !maskValid) return;

    // 4) coleta dados
    const f     = new FormData(form);
    const dados = Object.fromEntries(f.entries());

    // 5) monta payload
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
      ANO:         dados.ano,
      RESPONSAVEL: dados.responsavel
    };

    // 6) overlay + loading
    overlay.style.display = 'flex';
    let animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/animacao/confirm-success.json'
    });

    // 7) envia
    let savedOK = true;
    try {
      const resp = await fetch(`${BACKEND}/api/gerar-termo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sheetPayload),
      });
      if (!resp.ok) savedOK = false;
    } catch {
      savedOK = false;
    }

    // 8) resultado
    animation.destroy();
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: savedOK
        ? '/animacao/confirm-success.json'
        : '/animacao/confirm-error.json'
    });

    // 9) finaliza
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

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
        alert('Ocorreu um erro ao gravar no Google Sheets. Tente novamente.');
      }
    }, 2000);
  });
});

// helper para repopular data após reset
function populaDataSistema() {
  const hoje = new Date();
  const dia  = String(hoje.getDate()).padStart(2, '0');
  const mes  = hoje.toLocaleString('pt-BR', { month: 'long' });
  const ano  = hoje.getFullYear();
  ['dia','mes','ano'].forEach(id => {
    const el = document.getElementById(id);
    el.value = id === 'mes' ? mes : (id === 'dia' ? dia : ano);
  });
}
