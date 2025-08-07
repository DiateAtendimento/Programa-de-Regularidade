// frontend/script.js
document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('regularidadeForm');
  const critFeedback = document.getElementById('critFeedback');
  const overlay      = document.getElementById('lottie-overlay');
  const lottiePlayer = document.getElementById('lottie-player');
  const BACKEND      = 'https://programa-de-regularidade.onrender.com';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');

    // 1) validação nativa + critérios
    const formValid = form.checkValidity();
    const criterios = Array.from(
      form.querySelectorAll('input[name="criterios"]:checked')
    ).map(el => el.value);
    const criteriosValid = criterios.length >= 1;
    critFeedback.style.display = criteriosValid ? 'none' : 'block';
    if (!formValid || !criteriosValid) return;

    // 2) coleta dados do form
    const f     = new FormData(form);
    const dados = Object.fromEntries(f.entries());

    // 3) payload para o Google Sheets (chaves MAIÚSCULAS conforme aba “Dados”)
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

    // 4) overlay + loading
    overlay.style.display = 'flex';
    let animation = lottie.loadAnimation({
      container: lottiePlayer,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: '/animacao/confirm-success.json'
    });

    // 5) POST ao backend
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

    // 6) troca animação
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

    // 7) depois de 2s: esconde overlay, abre termo e reseta form
    setTimeout(() => {
      overlay.style.display = 'none';
      animation.destroy();

      if (savedOK) {
        const qs = new URLSearchParams();
        // mesma ordem/nomes do termo.html:
        qs.set('ente',        dados.ente);
        qs.set('cnpj',        dados.cnpj);
        qs.set('uf',          dados.uf);
        qs.set('cpf',         dados.cpf);
        qs.set('nome',        dados.nome);
        qs.set('telefone',    dados.telefone);
        qs.set('email',       dados.email);
        qs.set('endereco',    dados.endereco);
        qs.set('cidade',      dados.cidade);
        qs.set('dia',         dados.dia);
        qs.set('mes',         dados.mes);
        qs.set('ano',         dados.ano);
        qs.set('responsavel', dados.responsavel);
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
