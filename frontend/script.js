document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('regularidadeForm');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const formData = new FormData(form);

    // Monta objeto "dados" incluindo todos os campos e critérios como array
    const dados = {};
    for (let [key, value] of formData.entries()) {
      if (key === 'criterios') continue;
      dados[key] = value;
    }
    dados.criterios = formData.getAll('criterios');

    // 1) Grava no Google Sheets via API
    try {
      await fetch('/api/gerar-termo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados),
      });
    } catch (err) {
      console.error('Erro ao gravar no Sheets:', err);
    }

    // 2) Abre termo.html preenchido em nova aba
    const qs = new URLSearchParams(dados).toString();
    window.open(`termo.html?${qs}`, '_blank');
  });
});
