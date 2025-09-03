// script.js — Multi-etapas 100% estável: máscaras, stepper, modais/Lottie,
// buscas, validação, idempotência, retries e limpeza automática de rascunhos.

(() => {
  /* ========= Config ========= */
  const API_BASE = 'https://programa-de-regularidade.onrender.com';

  // Limpeza automática de rascunhos não finalizados ao abrir a página
  const AUTO_CLEAR_DRAFTS = true;                 // mude para false se quiser permitir retomar rascunho
  const FORM_TTL_MS = 30 * 60 * 1000;             // 30 min de validade do rascunho

  /* ========= Idempotência (frontend) ========= */
  const IDEM_STORE_KEY = 'rpps-idem-submit';

  function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  function newIdemKey() {
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return 'id_' + hex(a);
    } catch {
      return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  function rememberIdemKey(key) {
    try { localStorage.setItem(IDEM_STORE_KEY, JSON.stringify({ key, ts: Date.now() })); } catch {}
  }
  function takeIdemKey() {
    try {
      const raw = localStorage.getItem(IDEM_STORE_KEY);
      if (!raw) return null;
      const { key } = JSON.parse(raw);
      return key || null;
    } catch { return null; }
  }
  function clearIdemKey() { try { localStorage.removeItem(IDEM_STORE_KEY); } catch {} }

  /* ========= Robustez de rede ========= */
  const FETCH_TIMEOUT_MS = 20000; // 20s
  const FETCH_RETRIES = 2;        // tentativas além da primeira

  async function fetchJSON(
    url,
    { method = 'GET', headers = {}, body = null } = {},
    { label = 'request', timeout = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}
  ) {
    let attempt = 0;

    // cache-busting por querystring
    const bust = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sep = url.includes('?') ? '&' : '?';
    const finalURL = `${url}${sep}${bust}`;

    const finalHeaders = { ...headers };

    while (true) {
      attempt++;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(`timeout:${label}`), timeout);
      try {
        const res = await fetch(finalURL, {
          method,
          headers: finalHeaders,
          body,
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'follow',
          mode: 'cors'
        });
        clearTimeout(to);

        if (!res.ok) {
          const isJson = (res.headers.get('content-type') || '').includes('application/json');
          const data = isJson ? (await res.json().catch(() => null)) : null;
          const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
      } catch (e) {
        clearTimeout(to);
        const m = String(e?.message || '').toLowerCase();
        const isHttp = (e && typeof e.status === 'number');
        const retriable =
          (isHttp && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || e.status >= 500)) ||
          m.includes('etimedout') || m.includes('timeout:') || m.includes('abort') ||
          m.includes('econnreset') || m.includes('socket hang up') || m.includes('eai_again') ||
          (!navigator.onLine) ||
          m.includes('failed') || m.includes('bad gateway');

        if (!retriable || attempt > (retries + 1)) throw e;

        const backoff = 300 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  async function waitForService({ timeoutMs = 60_000, pollMs = 2000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await fetchJSON(`${API_BASE}/api/health`, {}, { label: 'health', timeout: 4000, retries: 0 });
        if (r && r.ok) return true;
      } catch (_) {}
      await new Promise(r => setTimeout(r, pollMs));
    }
    return false;
  }

  function friendlyErrorMessages(err, fallback='Falha ao comunicar com o servidor.') {
    const status = err?.status;
    const msg = String(err?.message || '').toLowerCase();

    if (!navigator.onLine) return ['Sem conexão com a internet. Verifique sua rede e tente novamente.'];
    if (status === 504 || msg.includes('timeout:')) return ['Tempo de resposta esgotado. Tente novamente em instantes.'];
    if (status === 502 || msg.includes('bad gateway')) return ['Servidor reiniciando. Tente novamente em alguns segundos.'];
    if (status === 429 || msg.includes('rate limit')) return ['Muitas solicitações no momento. Aguarde alguns segundos e tente novamente.'];
    if (status === 404) return ['Registro não encontrado. Verifique os dados informados.'];
    if (status && status >= 500) return ['Instabilidade no servidor. Tente novamente em instantes.'];
    return [fallback];
  }

  /* ========= Helpers ========= */
  const $  = (s, r=document)=> r.querySelector(s);
  const $$ = (s, r=document)=> Array.from(r.querySelectorAll(s));
  const digits = v => String(v||'').replace(/\D+/g,'');
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fmtBR = d => d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const fmtHR = d => d.toLocaleTimeString('pt-BR',{hour12:false,timeZone:'America/Sao_Paulo'});
  const rmAcc = s => String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();

  function getVal(row, header) {
    const k = Object.keys(row).find(h => String(h).trim().toUpperCase() === String(header).trim().toUpperCase());
    return k ? row[k] : '';
  }

  const normCmp = v => (v ?? '').toString().trim()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/\s+/g,' ')
    .toLowerCase();

  const onlyDigits = v => (v ?? '').toString().replace(/\D+/g, '');

  function tipoAlteracao(prev, next) {
    const p = (prev ?? '').toString().trim();
    const n = (next ?? '').toString().trim();
    if (!p && n) return 'INCLUSAO';
    if (p && p !== n) return 'ALTERACAO';
    return '';
  }

  // Modais
  const modalErro     = new bootstrap.Modal($('#modalErro'));
  const modalSucesso  = new bootstrap.Modal($('#modalSucesso'));
  const modalWelcome  = new bootstrap.Modal($('#modalWelcome'));
  const modalLoadingSearch = new bootstrap.Modal($('#modalLoadingSearch'), { backdrop:'static', keyboard:false });
  const modalGerandoPdf = new bootstrap.Modal($('#modalGerandoPdf'), { backdrop:'static', keyboard:false });
  const btnGerar = document.getElementById('btnGerarForm');

  /* ========= Persistência (etapa + campos) ========= */
  const STORAGE_KEY = 'rpps-form-v1';

  function clearAllState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    clearIdemKey();
  }

  function getState(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }
  function setState(updater){
    const prev = getState() || { step: 0, values: {}, seenWelcome: false, lastSaved: 0, finalizedAt: 0 };
    const next = (typeof updater === 'function') ? updater(prev) : { ...prev, ...updater };
    next.lastSaved = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }
  function markWelcomeSeen(){ setState(s => ({ ...s, seenWelcome: true })); }

  function saveState() {
    const prev = getState();
    const data = {
      step,
      values: {},
      seenWelcome: prev?.seenWelcome ?? false,
      lastSaved: Date.now(),
      finalizedAt: prev?.finalizedAt || 0
    };
    [
      'UF','ENTE','CNPJ_ENTE','EMAIL_ENTE','UG','CNPJ_UG','EMAIL_UG',
      'CPF_REP_ENTE','NOME_REP_ENTE','CARGO_REP_ENTE','EMAIL_REP_ENTE','TEL_REP_ENTE',
      'CPF_REP_UG','NOME_REP_UG','CARGO_REP_UG','EMAIL_REP_UG','TEL_REP_UG',
      'DATA_VENCIMENTO_ULTIMO_CRP'
    ].forEach(id => { const el = document.getElementById(id); if (el) data.values[id] = el.value; });

    data.values['em_adm'] = !!document.getElementById('em_adm')?.checked;
    data.values['em_jud'] = !!document.getElementById('em_jud')?.checked;

    ['CRITERIOS_IRREGULARES[]','COMPROMISSOS[]','PROVIDENCIAS[]'].forEach(name => {
      data.values[name] = $$(`input[name="${name}"]:checked`).map(i => i.value);
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }


  // ======== payload ========
  function buildPayload(){
    return {
      ENTE: $('#ENTE').value.trim(),
      UF: $('#UF').value.trim(),
      CNPJ_ENTE: digits($('#CNPJ_ENTE').value),
      EMAIL_ENTE: $('#EMAIL_ENTE').value.trim(),
      NOME_REP_ENTE: $('#NOME_REP_ENTE').value.trim(),
      CARGO_REP_ENTE: $('#CARGO_REP_ENTE').value.trim(),
      CPF_REP_ENTE: digits($('#CPF_REP_ENTE').value),
      EMAIL_REP_ENTE: $('#EMAIL_REP_ENTE').value.trim(),
      UG: $('#UG').value.trim(),
      CNPJ_UG: digits($('#CNPJ_UG').value),
      EMAIL_UG: $('#EMAIL_UG').value.trim(),
      NOME_REP_UG: $('#NOME_REP_UG').value.trim(),
      CARGO_REP_UG: $('#CARGO_REP_UG').value.trim(),
      CPF_REP_UG: digits($('#CPF_REP_UG').value),
      EMAIL_REP_UG: $('#EMAIL_REP_UG').value.trim(),
      DATA_VENCIMENTO_ULTIMO_CRP: $('#DATA_VENCIMENTO_ULTIMO_CRP').value || '',
      TIPO_EMISSAO_ULTIMO_CRP:
        ($('#em_adm').checked && 'Administrativa') ||
        ($('#em_jud').checked && 'Judicial') || '',
      CRITERIOS_IRREGULARES: $$('input[name="CRITERIOS_IRREGULARES[]"]:checked').map(i=>i.value),
      CELEBRACAO_TERMO_PARCELA_DEBITOS: $$('input#parc60, input#parc300').filter(i=>i.checked).map(i=>i.value).join('; '),
      REGULARIZACAO_PENDEN_ADMINISTRATIVA: $$('input#reg_sem_jud, input#reg_com_jud').filter(i=>i.checked).map(i=>i.value).join('; '),
      DEFICIT_ATUARIAL: $$('input#eq_implano, input#eq_prazos, input#eq_plano_alt').filter(i=>i.checked).map(i=>i.value).join('; '),
      // REMOVIDO: CRITERIOS_ESTRUT_EStABELECIDOS (campo legado com typo)
      CRITERIOS_ESTRUT_ESTABELECIDOS: $$('input#org_ugu, input#org_outros').filter(i=>i.checked).map(i=>i.value).join('; '),
      MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS: $$('input#man_cert, input#man_melhoria, input#man_acomp').filter(i=>i.checked).map(i=>i.value).join('; '),
      COMPROMISSO_FIRMADO_ADESAO: $$('input[name="COMPROMISSOS[]"]:checked').map(i=>i.value).join('; '),
      PROVIDENCIA_NECESS_ADESAO: $$('input[name="PROVIDENCIAS[]"]:checked').map(i=>i.value).join('; '),
      CONDICAO_VIGENCIA: $('#DECL_CIENCIA').checked ? 'Declaro ciência das condições' : '',
      MES: $('#MES').value,
      DATA_TERMO_GERADO: $('#DATA_TERMO_GERADO').value,
      HORA_TERMO_GERADO: $('#HORA_TERMO_GERADO').value,
      ANO_TERMO_GERADO: $('#ANO_TERMO_GERADO').value,
      __snapshot_base: snapshotBase,
      __user_changed_fields: Array.from(editedFields),
      IDEMP_KEY: takeIdemKey() || ''
    };
  }

  // ======== Preview (opcional) ========
  function openTermoWithPayload(payload, autoFlag){
    const esfera = ($('#esf_mun')?.checked ? 'RPPS Municipal' :
                    ($('#esf_est')?.checked ? 'Estadual/Distrital' : ''));
    const qs = new URLSearchParams({
      uf: payload.UF, ente: payload.ENTE, cnpj_ente: $('#CNPJ_ENTE').value,
      email_ente: payload.EMAIL_ENTE,
      ug: payload.UG, cnpj_ug: $('#CNPJ_UG').value,
      email_ug: payload.EMAIL_UG,
      esfera,
      nome_rep_ente: payload.NOME_REP_ENTE, cpf_rep_ente: $('#CPF_REP_ENTE').value,
      cargo_rep_ente: payload.CARGO_REP_ENTE, email_rep_ente: payload.EMAIL_REP_ENTE,
      nome_rep_ug: payload.NOME_REP_UG, cpf_rep_ug: $('#CPF_REP_UG').value,
      cargo_rep_ug: payload.CARGO_REP_UG, email_rep_ug: payload.EMAIL_REP_UG,
      venc_ult_crp: $('#DATA_VENCIMENTO_ULTIMO_CRP').value,
      tipo_emissao_crp: payload.TIPO_EMISSAO_ULTIMO_CRP,
      celebracao: payload.CELEBRACAO_TERMO_PARCELA_DEBITOS,
      regularizacao: payload.REGULARIZACAO_PENDEN_ADMINISTRATIVA,
      deficit: payload.DEFICIT_ATUARIAL,
      criterios_estrut: payload.CRITERIOS_ESTRUT_ESTABELECIDOS,
      manutencao_normas: payload.MANUTENCAO_CONFORMIDADE_NORMAS_GERAIS,
      compromisso: payload.COMPROMISSO_FIRMADO_ADESAO,
      providencias: payload.PROVIDENCIA_NECESS_ADESAO,
      condicao_vigencia: payload.CONDICAO_VIGENCIA,
      data_termo: $('#DATA_TERMO_GERADO').value,
      auto: String(autoFlag || '1')
    });

    const compAgg = String(payload.COMPROMISSO_FIRMADO_ADESAO || '');
    [['5.1','5\\.1'], ['5.2','5\\.2'], ['5.3','5\\.3'], ['5.4','5\\.4'], ['5.5','5\\.5'], ['5.6','5\\.6']]
      .forEach(([code, rx]) => {
        if (new RegExp(`(^|\\D)${rx}(\\D|$)`).test(compAgg)) qs.append('comp', code);
      });

    payload.CRITERIOS_IRREGULARES.forEach((c, i) => qs.append(`criterio${i+1}`, c));
    window.open(`termo.html?${qs.toString()}`, '_blank', 'noopener');
  }

  /* ========= Helper: gerar & baixar PDF ========= */
  async function gerarBaixarPDF(payload){
    const esfera =
      ($('#esf_mun')?.checked ? 'RPPS Municipal' :
      ($('#esf_est')?.checked ? 'Estadual/Distrital' : ''));
    const body = { ...payload, ESFERA: esfera };

    const res = await fetch(`${API_BASE}/api/termo-pdf?_ts=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      mode: 'cors'
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error(`Falha ao gerar PDF (${res.status}) ${txt}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const ente = String(payload.ENTE || 'termo-adesao')
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[^\w\-]+/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'')
      .toLowerCase();
    a.download = `termo-${ente}.pdf`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ========= AÇÃO: Gerar Formulário (download do PDF) ========= */
  let gerarBusy = false;

  btnGerar?.addEventListener('click', async () => {
    if (gerarBusy) return;

    for (let s = 1; s <= 8; s++) { if (!validateStep(s)) return; }

    gerarBusy = true;
    if (btnGerar) btnGerar.disabled = true;

    fillNowHiddenFields();
    const payload = buildPayload();

    try {
      safeShowModal(modalGerandoPdf);
      await gerarBaixarPDF(payload);
      try { modalGerandoPdf.hide(); } catch {}
      safeShowModal(modalSucesso);
    } catch (e) {
      try { modalGerandoPdf.hide(); } catch {}
      showErro(['Não foi possível gerar o PDF.', e?.message || '']);
    } finally {
      unlockUI();  // não feche a modal de sucesso/erro
      if (btnGerar) btnGerar.disabled = false;
      gerarBusy = false;
    }
  });

  /* ========= Submit / Finalizar (com espera + reenvio seguro) ========= */
  const form = document.getElementById('regularidadeForm');

  // evita Enter antes da etapa 8
  form?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && step < 8) {
      const t = e.target;
      const isTextualInput =
        t && t.tagName === 'INPUT' && !['button','submit','checkbox','radio','file'].includes(t.type);
      const isTextarea = t && t.tagName === 'TEXTAREA';
      if (isTextualInput || isTextarea) e.preventDefault();
    }
  });

  // Enter na pesquisa
  document.getElementById('CNPJ_ENTE_PESQ')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btnPesquisar')?.click();
    }
  });

  form?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    for (let s=1; s<=8; s++){ if(!validateStep(s)) return; }

    await upsertBaseIfMissing();
    await upsertRepresentantes();

    fillNowHiddenFields();

    // gera/guarda chave de idempotência antes do 1º POST
    const idem = takeIdemKey() || newIdemKey();
    rememberIdemKey(idem);

    const payload = buildPayload(); // incluirá IDEMP_KEY (se existir)

    const submitOriginalHTML = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = 'Finalizando…';

    try {
      // 1ª tentativa
      await fetchJSON(
        `${API_BASE}/api/gerar-termo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idem
          },
          body: JSON.stringify(payload),
        },
        { label: 'gerar-termo', timeout: 30000, retries: 1 }
      );

      clearIdemKey();
      btnSubmit.innerHTML = 'Finalizado ✓';

      // Limpa TUDO (zera rascunho) e volta para o passo 0
      setTimeout(() => {
        form.reset();
        $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
        $$('input[type="checkbox"], input[type="radio"]').forEach(el=> el.checked=false);
        editedFields.clear();
        snapshotBase = null;
        cnpjOK = false;
        clearAllState(); // <- apaga STORAGE_KEY + idem
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = submitOriginalHTML;
        showStep(0);
      }, 800);

    } catch (err) {
      // se for falha típica de reinício (502/503/504 / timeout / offline), espera e reenfila 1x com MESMA chave
      const msg = String(err?.message || '').toLowerCase();
      const status = err?.status || 0;
      const canWait =
        status === 502 || status === 503 || status === 504 ||
        msg.includes('timeout:') || !navigator.onLine || msg.includes('bad gateway');

      if (canWait) {
        btnSubmit.innerHTML = 'Aguardando serviço…';
        const ok = await waitForService({ timeoutMs: 60_000, pollMs: 2500 });
        if (ok) {
          try {
            await fetchJSON(
              `${API_BASE}/api/gerar-termo`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Idempotency-Key': idem
                },
                body: JSON.stringify(payload),
              },
              { label: 'gerar-termo(retry-after-wait)', timeout: 30000, retries: 0 }
            );
            clearIdemKey();
            btnSubmit.innerHTML = 'Finalizado ✓';
            setTimeout(() => {
              form.reset();
              $$('.is-valid, .is-invalid').forEach(el=>el.classList.remove('is-valid','is-invalid'));
              $$('input[type="checkbox"], input[type="radio"]').forEach(el=> el.checked=false);
              editedFields.clear();
              snapshotBase = null;
              cnpjOK = false;
              clearAllState();
              btnSubmit.disabled = false;
              btnSubmit.innerHTML = submitOriginalHTML;
              showStep(0);
            }, 800);
            return;
          } catch (err2) {
            showErro(friendlyErrorMessages(err2, 'Falha ao registrar o termo.'));
          }
        } else {
          showErro(['Servidor indisponível no momento. Tente novamente mais tarde.']);
        }
      } else {
        showErro(friendlyErrorMessages(err, 'Falha ao registrar o termo.'));
      }

      // estado de erro → mantém botão habilitado e preserva idemKey para reenvio manual
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = submitOriginalHTML;
    }
  });

  // restoreState — com política de limpeza
  function restoreState() {
    const st = loadState();
    if (!st) { showStep(0); return; }

    // Se AUTO_CLEAR_DRAFTS estiver ativo, não restauramos rascunhos
    if (AUTO_CLEAR_DRAFTS) {
      clearAllState();
      showStep(0);
      return;
    }

    const now = Date.now();
    if (st.lastSaved && (now - st.lastSaved > FORM_TTL_MS)) {
      clearAllState();
      showStep(0);
      return;
    }

    const vals = st.values || {};
    Object.entries(vals).forEach(([k, v]) => {
      if (k.endsWith('[]')) {
        $$(`input[name="${k}"]`).forEach(i => { i.checked = Array.isArray(v) && v.includes(i.value); });
      } else if (k === 'em_adm' || k === 'em_jud') {
        const el = document.getElementById(k);
        if (el) el.checked = !!v;
      } else {
        const el = document.getElementById(k);
        if (el) el.value = v ?? '';
      }
    });

    let n = Number.isFinite(st.step) ? Number(st.step) : 0;

    if (n === 0) {
      cnpjOK = false;
      const pesq = document.getElementById('CNPJ_ENTE_PESQ');
      if (pesq) { pesq.value = ''; neutral(pesq); }
    } else {
      cnpjOK = digits(vals.CNPJ_ENTE || vals.CNPJ_UG || '').length === 14;
    }

    showStep(Math.max(0, Math.min(8, n)));
    if (st.seenWelcome) { try { modalWelcome.hide(); } catch {} }
  }

  restoreState();
})();
