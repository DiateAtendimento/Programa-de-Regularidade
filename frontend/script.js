// script.js

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('regularidadeForm');
  const critFieldset = document.getElementById('critFieldset');
  const critFeedback = document.getElementById('critFeedback');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // marca o form como validado para exibir estilos de erro do Bootstrap
    form.classList.add('was-validated');

    // 1) validação nativa dos campos required
    const formValid = form.checkValidity();

    // 2) validação personalizada: pelo menos um critério deve estar marcado
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;

    if (!criteriosValid) {
      critFeedback.style.display = 'block';
    } else {
      critFeedback.style.display = 'none';
    }

    // 3) se algo inválido, interrompe aqui
    if (!formValid || !criteriosValid) {
      return;
    }

    // 4) monta o objeto "dados" para envio
    const formData = new FormData(form);
    const dados = {};
    for (let [key, value] of formData.entries()) {
      if (key === 'criterios') continue;
      dados[key] = value;
    }
    dados.criterios = criterios;

    // 5) grava no Google Sheets (fire-and-forget)
    try {
      const resp = await fetch('/api/gerar-termo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados),
      });
      if (!resp.ok) {
        console.error('Falha ao gravar no Sheets:', resp.status);
      }
    } catch (err) {
      console.error('Erro ao gravar no Sheets:', err);
    }

    // 6) abre o termo em nova aba, passando os dados como query string
    const qs = new URLSearchParams(dados).toString();
    window.open(`termo.html?${qs}`, '_blank');
  });
});
