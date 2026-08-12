(() => {
  'use strict';

  const form = document.getElementById('requerimentoForm');
  const alertBox = document.getElementById('formAlert');
  const successBox = document.getElementById('successBox');
  const submitButton = document.getElementById('btnGerar');
  const submitLabel = submitButton.querySelector('.btn-label');
  const spinner = submitButton.querySelector('.spinner-border');
  const searchInput = document.getElementById('cnpjEntePesquisa');
  const searchButton = document.getElementById('btnPesquisarCnpj');
  const cnpjInput = document.getElementById('cnpj');
  const phoneInput = document.getElementById('telefoneContato');
  const dateInput = document.getElementById('dataRequerimento');
  const representativeInput = document.getElementById('representanteUg');
  const representativeRoleInput = document.getElementById('cargoRepresentanteUg');
  const sections = Array.from(form.querySelectorAll('[data-step]'));
  const indicators = Array.from(document.querySelectorAll('[data-step-indicator]'));
  const previousButton = document.getElementById('btnPrev');
  const nextButton = document.getElementById('btnNext');
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const apiBase = isLocal ? '/api' : '/.netlify/functions/api-proxy';
  const apiEndpoint = `${apiBase}/requerimento-anexo-v`;
  const consultationEndpoint = `${apiBase}/consulta`;
  const loadingModalElement = document.getElementById('modalLoadingSearch');
  const loadingModal = window.bootstrap && loadingModalElement
    ? new window.bootstrap.Modal(loadingModalElement, { backdrop: 'static', keyboard: false })
    : null;

  const digits = (value) => String(value || '').replace(/\D+/g, '');
  const declarationLetters = 'ABCDEFGHIJ'.split('');
  let currentStep = 0;
  let searchCompleted = false;
  let searching = false;
  let idempotencyKey = null;
  let successAnimation = null;
  let loadingAnimation = null;

  function formatCnpj(value) {
    return digits(value).slice(0, 14)
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  }

  function formatPhone(value) {
    const raw = digits(value).slice(0, 11);
    if (raw.length <= 10) {
      return raw.replace(/^(\d{0,2})(\d{0,4})(\d{0,4}).*/, (_, area, prefix, suffix) =>
        `${area ? `(${area}` : ''}${area.length === 2 ? ') ' : ''}${prefix}${suffix ? `-${suffix}` : ''}`);
    }
    return raw.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  }

  function formatDate(value) {
    return digits(value).slice(0, 8)
      .replace(/^(\d{2})(\d)/, '$1/$2')
      .replace(/^(\d{2})\/(\d{2})(\d)/, '$1/$2/$3');
  }

  function isValidCnpj(value) {
    const cnpj = digits(value);
    if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
    const calc = (length) => {
      let sum = 0;
      let weight = length - 7;
      for (let index = 0; index < length; index += 1) {
        sum += Number(cnpj[index]) * weight;
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
    return date.getFullYear() === Number(match[3])
      && date.getMonth() === Number(match[2]) - 1
      && date.getDate() === Number(match[1]);
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

  function showStep(stepNumber) {
    currentStep = Math.max(0, Math.min(sections.length - 1, stepNumber));
    sections.forEach((section, index) => {
      section.hidden = index !== currentStep;
      section.classList.toggle('d-none', index !== currentStep);
    });
    indicators.forEach((indicator, index) => {
      indicator.classList.toggle('active', index === currentStep);
      indicator.classList.toggle('completed', index < currentStep);
      indicator.setAttribute('aria-current', index === currentStep ? 'step' : 'false');
    });
    previousButton.classList.toggle('d-none', currentStep === 0);
    nextButton.classList.toggle('d-none', currentStep === sections.length - 1);
    nextButton.disabled = currentStep === 0 && !searchCompleted;
    document.getElementById('stepper').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  function mountLoadingAnimation() {
    const container = document.getElementById('lottieLoadingSearch');
    if (!container || !window.lottie || loadingAnimation) return;
    loadingAnimation = window.lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: 'animacao/carregando-info.json'
    });
  }

  function resetFormAfterSuccess() {
    form.reset();
    form.querySelectorAll('.is-valid, .is-invalid, .autofilled').forEach((control) => {
      control.classList.remove('is-valid', 'is-invalid', 'autofilled');
    });
    document.getElementById('nivelFeedback').classList.add('d-none');
    dateInput.value = todayBr();
    idempotencyKey = null;
    searchCompleted = false;
    syncRepresentativeSummary();
    showStep(0);
  }

  function setField(id, value, formatter = null) {
    const field = document.getElementById(id);
    if (!field) return;
    const normalized = String(value || '').trim();
    field.value = formatter && normalized ? formatter(normalized) : normalized;
    field.classList.toggle('autofilled', Boolean(normalized));
  }

  function clearIdentification() {
    sections[1].querySelectorAll('input, select').forEach((field) => {
      field.value = '';
      field.classList.remove('is-valid', 'is-invalid', 'autofilled');
    });
    syncRepresentativeSummary();
  }

  function clearDataFromPreviousSearch() {
    sections.slice(1).forEach((section) => {
      section.querySelectorAll('input, select').forEach((field) => {
        if (field.type === 'radio' || field.type === 'checkbox') field.checked = false;
        else field.value = '';
        field.classList.remove('is-valid', 'is-invalid', 'autofilled');
      });
    });
    document.getElementById('nivelFeedback').classList.add('d-none');
    dateInput.value = todayBr();
    idempotencyKey = null;
    syncRepresentativeSummary();
  }

  function populateIdentification(result, searchedCnpj) {
    clearDataFromPreviousSearch();
    clearIdentification();
    const data = result?.data || {};
    const snapshot = data.__snapshot || {};
    const cnpjEnte = digits(data.CNPJ_ENTE || snapshot.CNPJ_ENTE || searchedCnpj);
    const cnpjUg = digits(data.CNPJ_UG || snapshot.CNPJ_UG || '');

    setField('enteFederativo', data.ENTE);
    setField('uf', data.UF);
    setField('unidadeGestora', data.UG);
    setField('cnpj', cnpjUg || cnpjEnte, formatCnpj);
    setField('representanteEnte', snapshot.NOME_REP_ENTE);
    setField('cargoRepresentanteEnte', snapshot.CARGO_REP_ENTE);
    setField('representanteUg', snapshot.NOME_REP_UG);
    setField('cargoRepresentanteUg', snapshot.CARGO_REP_UG);
    setField('emailContato', data.EMAIL_UG || snapshot.EMAIL_REP_UG || data.EMAIL_ENTE || snapshot.EMAIL_REP_ENTE);
    setField('telefoneContato', snapshot.TEL_REP_UG || snapshot.TEL_REP_ENTE, formatPhone);
    syncRepresentativeSummary();
  }

  function validateRequiredControls(container) {
    let firstInvalid = null;
    container.querySelectorAll('input[required], select[required]').forEach((control) => {
      if (control.type === 'radio' || control.type === 'checkbox') return;
      let valid = control.checkValidity();
      if (control === cnpjInput) valid = isValidCnpj(control.value);
      if (control === phoneInput) valid = [10, 11].includes(digits(control.value).length);
      if (control === dateInput) valid = isValidDate(control.value);
      control.classList.toggle('is-invalid', !valid);
      control.classList.toggle('is-valid', valid && Boolean(control.value));
      if (!valid && !firstInvalid) firstInvalid = control;
    });
    return firstInvalid;
  }

  function focusInvalid(control) {
    if (!control) return;
    control.focus({ preventScroll: true });
    control.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function validateStep(stepNumber, showMessages = true) {
    if (stepNumber === 0) {
      const valid = isValidCnpj(searchInput.value) && searchCompleted;
      searchInput.classList.toggle('is-invalid', !valid);
      if (!valid && showMessages) showAlert('Pesquise um CNPJ válido antes de continuar.');
      if (!valid) focusInvalid(searchInput);
      return valid;
    }

    if (stepNumber === 1 || stepNumber === 4) {
      const invalid = validateRequiredControls(sections[stepNumber]);
      if (invalid && showMessages) showAlert('Revise os campos destacados antes de continuar.');
      if (invalid) focusInvalid(invalid);
      return !invalid;
    }

    if (stepNumber === 2) {
      const selected = form.querySelector('input[name="NIVEL_PRO_GESTAO"]:checked');
      const levelInputs = Array.from(form.querySelectorAll('input[name="NIVEL_PRO_GESTAO"]'));
      levelInputs.forEach((input) => input.classList.toggle('is-invalid', !selected));
      document.getElementById('nivelFeedback').classList.toggle('d-none', Boolean(selected));
      if (!selected && showMessages) showAlert('Selecione o nível II ou III para continuar.');
      if (!selected) focusInvalid(levelInputs[0]);
      return Boolean(selected);
    }

    if (stepNumber === 3) {
      const missingLetter = declarationLetters.find((letter) => !document.getElementById(`declaracao${letter}`).checked);
      if (!missingLetter) return true;
      const control = document.getElementById(`declaracao${missingLetter}`);
      control.classList.add('is-invalid');
      if (showMessages) showAlert(`Confirme a declaração ${missingLetter} para continuar.`);
      focusInvalid(control);
      return false;
    }

    return true;
  }

  function validateAllSteps() {
    for (let stepNumber = 1; stepNumber <= 4; stepNumber += 1) {
      showStep(stepNumber);
      if (!validateStep(stepNumber, true)) {
        return false;
      }
    }
    showStep(sections.length - 1);
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
    if (response.status === 429) return 'Muitas solicitações no momento. Aguarde alguns instantes e tente novamente.';
    if (response.status >= 500) return 'Não foi possível concluir a operação agora. Tente novamente em instantes.';
    return data?.error || 'Falha ao concluir a operação.';
  }

  async function searchByCnpj() {
    if (searching) return;
    hideAlerts();
    const cnpj = digits(searchInput.value);
    if (!isValidCnpj(cnpj)) {
      searchInput.classList.add('is-invalid');
      showAlert('Informe um CNPJ válido.');
      focusInvalid(searchInput);
      return;
    }

    try {
      searching = true;
      searchCompleted = false;
      searchButton.disabled = true;
      nextButton.disabled = true;
      mountLoadingAnimation();
      loadingModal?.show();

      const response = await fetch(`${consultationEndpoint}?cnpj=${encodeURIComponent(cnpj)}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(await parseError(response));
      const result = await response.json();

      populateIdentification(result, cnpj);
      searchCompleted = true;
      searchInput.classList.remove('is-invalid');
      searchInput.classList.add('is-valid');
      showStep(1);

      if (result.missing) {
        showAlert('CNPJ não encontrado na base. Complete manualmente os campos de identificação.', 'warning');
      }
    } catch (error) {
      const networkError = /failed to fetch|networkerror|load failed/i.test(String(error?.message || ''));
      showAlert(networkError
        ? 'Falha de comunicação com o servidor. Verifique sua conexão e tente novamente.'
        : error.message);
    } finally {
      loadingModal?.hide();
      searchButton.disabled = false;
      searching = false;
      nextButton.disabled = currentStep === 0 && !searchCompleted;
    }
  }

  searchInput.addEventListener('input', () => {
    searchInput.value = formatCnpj(searchInput.value);
    searchInput.classList.remove('is-valid', 'is-invalid');
    searchCompleted = false;
    nextButton.disabled = true;
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchByCnpj();
    }
  });
  searchButton.addEventListener('click', searchByCnpj);

  cnpjInput.addEventListener('input', () => { cnpjInput.value = formatCnpj(cnpjInput.value); });
  phoneInput.addEventListener('input', () => { phoneInput.value = formatPhone(phoneInput.value); });
  dateInput.addEventListener('input', () => { dateInput.value = formatDate(dateInput.value); });
  representativeInput.addEventListener('input', syncRepresentativeSummary);
  representativeRoleInput.addEventListener('input', syncRepresentativeSummary);

  form.addEventListener('input', (event) => {
    event.target.classList.remove('is-invalid', 'autofilled');
  });
  form.addEventListener('change', (event) => {
    event.target.classList.remove('is-invalid', 'autofilled');
  });

  previousButton.addEventListener('click', () => {
    hideAlerts();
    showStep(currentStep - 1);
  });
  nextButton.addEventListener('click', () => {
    hideAlerts();
    if (validateStep(currentStep, true)) showStep(currentStep + 1);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlerts();
    if (currentStep !== sections.length - 1 || !validateAllSteps()) return;

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
      document.getElementById('numeroControle').textContent = response.headers.get('x-control-number')
        || response.headers.get('x-request-id')
        || 'Gerado';
      resetFormAfterSuccess();
      successBox.classList.remove('d-none');
      playSuccessAnimation();
      successBox.focus({ preventScroll: true });
      successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      const networkError = /failed to fetch|networkerror|load failed/i.test(String(error?.message || ''));
      showAlert(networkError
        ? 'Falha de comunicação com o servidor. Verifique sua conexão e tente novamente.'
        : error.message);
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = 'Gerar Requerimento';
      spinner.classList.add('d-none');
    }
  });

  dateInput.value = todayBr();
  syncRepresentativeSummary();
  mountLoadingAnimation();
  showStep(0);
})();
