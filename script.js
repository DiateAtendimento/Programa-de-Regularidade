//script.js

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('regularidadeForm');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());

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
      a.href     = url;
      const cnpj  = (data.cnpj||'').replace(/\D/g,'') || 'termo';
      a.download = `termo_${cnpj}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o termo. Veja o console.');
    }
  });
});
