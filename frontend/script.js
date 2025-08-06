// frontend/script.js

document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  let animation      = null;

  // URL do seu backend Node (exemplo: Render)
  const BACKEND = 'https://programa-de-regularidade.onrender.com';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');

    // validador nativo
    const formValid = form.checkValidity();
    // validador de critérios
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;
    critFeedback.style.display = criteriosValid ? 'none' : 'block';

    if (!formValid || !criteriosValid) return;

    // monta objeto de dados
    const formData = new FormData(form);
    const dados    = {};
    for (let [key, val] of formData.entries()) {
      if (key === 'criterios') continue;
      dados[key] = val;
    }
    dados.criterios = criterios;

    // mostra overlay + animação de loading
    overlay.style.display = 'flex';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/animacao/confirm-success.json'
    });

    // envia ao Sheets
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

    // troca animação conforme resultado
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

    // após 2s, oculta overlay / limpa form / abre termo
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

      if (savedOK) {
        const qs = new URLSearchParams(dados).toString();
        window.open(`termo.html?${qs}`, '_blank');
        form.reset();
        form.classList.remove('was-validated');
        critFeedback.style.display = 'none';
      } else {
        alert('Ocorreu um erro ao gerar o termo. Tente novamente.');
      }
    }, 2000);
  });
});
