// script.js

document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  let animation      = null;
  const BACKEND = 'https://programa-de-regularidade.onrender.com';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // 1) exibe validação Bootstrap
    form.classList.add('was-validated');

    // 2) validação nativa dos campos required
    const formValid = form.checkValidity();

    // 3) validação personalizada: pelo menos um critério deve estar marcado
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;
    critFeedback.style.display = criteriosValid ? 'none' : 'block';

    // se algo inválido, aborta
    if (!formValid || !criteriosValid) return;

    // 4) monta o objeto de dados a partir do form
    const formData = new FormData(form);
    const dados    = {};
    for (let [key, val] of formData.entries()) {
      if (key === 'criterios') continue;
      dados[key] = val;
    }
    dados.criterios = criterios;

    // 5) mostra overlay e inicia animação de “processando”
    overlay.style.display = 'flex';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/animacao/confirm-success.json' // animação genérica de loading
    });

    // 6) grava no Google Sheets
    let savedOK = true;
    try {
      const resp = await fetch(`${BACKEND}/api/gerar-termo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados),
      });
      if (!resp.ok) savedOK = false;
    } catch {
      savedOK = false;
    }

    // 7) troca animação conforme resultado
    animation.destroy();
    const resultPath = savedOK
      ? '/animacao/confirm-success.json'
      : '/animacao/confirm-error.json';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: resultPath
    });

    // 8) após 2s, oculta overlay, limpa form e abre termo em caso de sucesso
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

      if (savedOK) {
        // abre termo.html em nova aba
        const qs = new URLSearchParams(dados).toString();
        window.open(`termo.html?${qs}`, '_blank');

        // limpa campos e estado de validação
        form.reset();
        form.classList.remove('was-validated');
        critFeedback.style.display = 'none';
      } else {
        alert('Ocorreu um erro ao gerar o termo. Tente novamente.');
      }
    }, 2000);
  });
});
