//script.js

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('regularidadeForm');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const formData = new FormData(form);

    // coleta todos os critérios como array
    const criterios = formData.getAll('criterios');

    // coleta demais campos
    const data = Object.fromEntries(
      Array.from(formData.entries())
        .filter(([key]) => key !== 'criterios')
    );
    data.criterios = criterios;

    try {
      const res = await fetch('/api/gerar-termo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const cnpjClean = (data.cnpj || '').replace(/\D/g, '') || 'termo';
      a.href     = url;
      a.download = `termo_${cnpjClean}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o termo. Confira o console.');
    }
  });
});
