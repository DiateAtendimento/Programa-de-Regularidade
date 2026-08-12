(() => {
  'use strict';

  const form = document.getElementById('requerimentoForm');
  const alertBox = document.getElementById('formAlert');
  const successBox = document.getElementById('successBox');
  const submitButton = document.getElementById('btnGerar');
  const submitLabel = submitButton.querySelector('.btn-label');
  const spinner = submitButton.querySelector('.spinner-border');
  const cnpjInput = document.getElementById('cnpj');
  const phoneInput = document.getElementById('telefoneContato');
  const dateInput = document.getElementById('dataRequerimento');
  const representativeInput = document.getElementById('representanteUg');
  const representativeRoleInput = document.getElementById('cargoRepresentanteUg');
  const apiEndpoint = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? '/api/requerimento-anexo-v'
    : '/.netlify/functions/api-proxy/requerimento-anexo-v';

  const digits = (value) => String(value || '').replace(/\D+/g, '');
  const declarationLetters = 'ABCDEFGHIJ'.split('');
  let idempotencyKey = null;
  let successAnimation = null;

  function formatCnpj(value) {
    return digits(value).slice(0, 14)
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  }

  function formatPhone(value) {
    const raw = digits(value).slice(0, 11);
    if (raw.length <= 10) return raw.replace(/^(\d{0,2})(\d{0,4})(\d{0,4}).*/, (_, a, b, c) => `${a ? `(${a}` : ''}${a.length === 2 ? ') ' : ''}${b}${c ? `-${c}` : ''}`);
    return raw.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  }

  function formatDate(value) {
    return digits(value).slice(0, 8).replace(/^(\d{2})(\d)/, '$1/$2').replace(/^(\d{2})\/(\d{2})(\d)/, '$1/$2/$3');
  }

  function isValidCnpj(value) {
    const cnpj = digits(value);
    if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
    const calc = (length) => {
      let sum = 0;
      let weight = length - 7;
      for (let i = 0; i < length; i += 1) {
        sum += Number(cnpj[i]) * weight;
        weight -= 1;
        if (weight < 2) weight = 9;
      }
      const result = 11 - (sum % 11);
      return result > 9 ? 0 : result;
    };
    return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
  }

  function isValidDate(value) {
    const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return false;
    const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    return date.getFullYear() === Number(match[3]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[1]);
  }

  function todayBr() {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  }

  function newIdempotencyKey() {
    try {
      return `anxv_${crypto.randomUUID()}`;
    } catch (_) {
      return `anxv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }

  function showAlert(message, kind = 'danger') {
    alertBox.className = `alert alert-${kind}`;
    alertBox.textContent = message;
    alertBox.classList.remove('d-none');
    alertBox.focus({ preventScroll: true });
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideAlerts() {
    alertBox.classList.add('d-none');
    successBox.classList.add('d-none');
  }

  function syncRepresentativeSummary() {
    document.getElementById('resumoRepresentanteUg').textContent = representativeInput.value.trim() || '—';
    document.getElementById('resumoCargoRepresentanteUg').textContent = representativeRoleInput.value.trim() || '—';
  }

  function playSuccessAnimation() {
    const container = document.getElementById('successLottie');
    if (!container || !window.lottie) return;
    if (successAnimation) successAnimation.destroy();
    successAnimation = window.lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: 'animacao/confirm-success.json'
    });
  }

  function resetFormAfterSuccess() {
    form.reset();
    form.querySelectorAll('.is-valid, .is-invalid').forEach((control) => {
      control.classList.remove('is-valid', 'is-invalid');
    });
    document.getElementById('nivelFeedback').classList.add('d-none');
    dateInput.value = todayBr();
    idempotencyKey = null;
    syncRepresentativeSummary();
  }

  function validateForm() {
    let firstInvalid = null;
    const controls = Array.from(form.querySelectorAll('input, select'));

    controls.forEach((control) => {
      if (control.type === 'radio') return;
      let valid = control.checkValidity();
      if (control === cnpjInput) valid = isValidCnpj(control.value);
      if (control === phoneInput) valid = [10, 11].includes(digits(control.value).length);
      if (control === dateInput) valid = isValidDate(control.value);
      control.classList.toggle('is-invalid', !valid);
      control.classList.toggle('is-valid', valid && control.value !== '');
      if (!valid && !firstInvalid) firstInvalid = control;
    });

    const selectedLevel = form.querySelector('input[name="NIVEL_PRO_GESTAO"]:checked');
    const levelInputs = Array.from(form.querySelectorAll('input[name="NIVEL_PRO_GESTAO"]'));
    levelInputs.forEach((input) => input.classList.toggle('is-invalid', !selectedLevel));
    document.getElementById('nivelFeedback').classList.toggle('d-none', Boolean(selectedLevel));
    if (!selectedLevel && !firstInvalid) firstInvalid = levelInputs[0];

    const missingDeclaration = declarationLetters.find((letter) => !document.getElementById(`declaracao${letter}`).checked);
    if (missingDeclaration) {
      const control = document.getElementById(`declaracao${missingDeclaration}`);
      control.classList.add('is-invalid');
      if (!firstInvalid) firstInvalid = control;
      showAlert(`Confirme a declaração ${missingDeclaration} para gerar o requerimento.`);
    }

    if (firstInvalid) {
      if (!missingDeclaration) showAlert('Revise os campos destacados antes de gerar o requerimento.');
      firstInvalid.focus({ preventScroll: true });
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  }

  function buildPayload() {
    const data = Object.fromEntries(new FormData(form).entries());
    declarationLetters.forEach((letter) => { data[`DECLARACAO_${letter}`] = true; });
    data.CNPJ = digits(data.CNPJ);
    data.TELEFONE_CONTATO = digits(data.TELEFONE_CONTATO);
    data.IDEMP_KEY = idempotencyKey || (idempotencyKey = newIdempotencyKey());
    return data;
  }

  function filenameFromResponse(response) {
    const disposition = response.headers.get('content-disposition') || '';
    const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8) return decodeURIComponent(utf8[1]);
    const simple = disposition.match(/filename="?([^";]+)"?/i);
    return simple ? simple[1] : 'Requerimento_Anexo_V.pdf';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function parseError(response) {
    const data = await response.json().catch(() => null);
    if (response.status === 400 && data?.details?.length) return data.details.join(' ');
    if (response.status === 409) return 'Este requerimento já foi processado. O documento será gerado novamente com o mesmo número de controle.';
    if (response.status === 429) return 'Muitas solicitações no momento. Aguarde alguns instantes e tente novamente.';
    if (response.status >= 500) return 'Não foi possível gerar o requerimento agora. Tente novamente em instantes.';
    return data?.error || 'Falha ao gerar o requerimento.';
  }

  cnpjInput.addEventListener('input', () => { cnpjInput.value = formatCnpj(cnpjInput.value); });
  phoneInput.addEventListener('input', () => { phoneInput.value = formatPhone(phoneInput.value); });
  dateInput.addEventListener('input', () => { dateInput.value = formatDate(dateInput.value); });
  representativeInput.addEventListener('input', syncRepresentativeSummary);
  representativeRoleInput.addEventListener('input', syncRepresentativeSummary);
  form.addEventListener('input', (event) => event.target.classList.remove('is-invalid'));
  form.addEventListener('change', (event) => event.target.classList.remove('is-invalid'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlerts();
    if (!validateForm()) return;

    submitButton.disabled = true;
    submitLabel.textContent = 'Gerando requerimento...';
    spinner.classList.remove('d-none');

    try {
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey || (idempotencyKey = newIdempotencyKey())
        },
        body: JSON.stringify(buildPayload()),
        cache: 'no-store',
        credentials: 'same-origin'
      });

      if (!response.ok) throw new Error(await parseError(response));
      const blob = await response.blob();
      if (!blob.size) throw new Error('O servidor retornou um arquivo vazio. Tente novamente.');

      downloadBlob(blob, filenameFromResponse(response));
      document.getElementById('numeroControle').textContent = response.headers.get('x-control-number') || response.headers.get('x-request-id') || 'Gerado';
      resetFormAfterSuccess();
      successBox.classList.remove('d-none');
      playSuccessAnimation();
      successBox.focus({ preventScroll: true });
      successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      const networkError = /failed to fetch|networkerror|load failed/i.test(String(error?.message || ''));
      showAlert(networkError ? 'Falha de comunicação com o servidor. Verifique sua conexão e tente novamente.' : error.message);
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = 'Gerar Requerimento';
      spinner.classList.add('d-none');
    }
  });

  dateInput.value = todayBr();
  syncRepresentativeSummary();
})();
