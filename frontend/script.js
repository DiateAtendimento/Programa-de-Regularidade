// script.js

document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  let animation      = null;

  // apontar para o seu backend (aqui Render)
  const BACKEND = 'https://programa-de-regularidade.onrender.com';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');

    // validação nativa + critérios
    const formValid = form.checkValidity();
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;
    critFeedback.style.display = criteriosValid ? 'none' : 'block';
    if (!formValid || !criteriosValid) return;

    // monta o objeto de dados com as **mesmas chaves** do cabeçalho da aba "Dados"
    const f = new FormData(form);
    const dados = Object.fromEntries(f.entries());
    // f.entries() retorna pares [key, val], mas precisamos ajustar:
    const payload = {
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

    // overlay + animação de loading
    overlay.style.display = 'flex';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/animacao/confirm-success.json'
    });

    // POST pro seu backend
    let savedOK = true;
    try {
      const resp = await fetch(`${BACKEND}/api/gerar-termo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) savedOK = false;
    } catch {
      savedOK = false;
    }

    // troca animação
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

    // após 2s, fecha overlay, limpa form e abre termo
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

      if (savedOK) {
        const qs = new URLSearchParams(payload).toString();
        window.open(`termo.html?${qs}`, '_blank');
        form.reset();
        form.classList.remove('was-validated');
        critFeedback.style.display = 'none';
      } else {
        alert('Ocorreu um erro ao gravar no Google Sheets. Tente novamente.');
      }
    }, 2000);
  });
});
