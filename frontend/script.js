// script.js

document.addEventListener('DOMContentLoaded', () => {
  const form           = document.getElementById('regularidadeForm');
  const critFeedback   = document.getElementById('critFeedback');
  const overlay        = document.getElementById('lottie-overlay');
  const lottiePlayer   = document.getElementById('lottie-player');
  let animation        = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // exibe validação Bootstrap
    form.classList.add('was-validated');

    // validação nativa
    const formValid = form.checkValidity();

    // validação de critérios
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

    // mostra overlay e inicia animação de “processando”
    overlay.style.display = 'flex';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/frontend/animacao/confirm-success.json' // ou confirm-error.json em caso de erro
    });

    // tenta gravar no Sheets
    let savedOK = true;
    try {
      const resp = await fetch('/api/gerar-termo', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(dados),
      });
      if (!resp.ok) savedOK = false;
    } catch {
      savedOK = false;
    }

    // troca animação conforme sucesso ou erro
    animation.destroy();
    const filePath = savedOK
      ? 'animacao/confirm-success.json'
      : 'animacao/confirm-error.json';
    animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: filePath
    });

    // após 2s, esconde overlay e abre o termo
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

      if (savedOK) {
        // abre termo.html em nova aba
        const qs = new URLSearchParams(dados).toString();
        window.open(`termo.html?${qs}`, '_blank');
      } else {
        alert('Ocorreu um erro ao gerar o termo. Refaça o processo.');
      }
    }, 2000);
  });
});
