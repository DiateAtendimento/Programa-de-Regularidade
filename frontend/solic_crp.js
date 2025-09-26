// solic_crp.js — lógica específica do form_gera_termo_solic_crp_2.html
// Mantém dependências mínimas e tenta integrar com o script base (window.app) quando existir.

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    cnpjInput: $('#CNPJ_ENTE_PESQ'),
    btnPesquisar: $('#btnPesquisar'),
    slotNextStep0: $('#slotNextStep0'),
    btnNext: $('#btnNext'),
    btnPrev: $('#btnPrev'),
    hasGescon: $('#HAS_TERMO_ENC_GESCON'),

    // info box (resultado Gescon)
    boxGescon: $('#gesconInfoBox'),
    spanNGescon: $('#N_GESCON'),
    spanDataEnc: $('#DATA_ENC_VIA_GESCON'),
    spanUfGescon: $('#UF_GESCON'),
    spanEnteGescon: $('#ENTE_GESCON'),

    // campos etapa 1 (vêm de Termos_registrados)
    uf: $('#UF'),
    ente: $('#ENTE'),
    cnpjEnte: $('#CNPJ_ENTE'),
    emailEnte: $('#EMAIL_ENTE'),
    ug: $('#UG'),
    cnpjUg: $('#CNPJ_UG'),
    emailUg: $('#EMAIL_UG'),

    // etapa 2 representantes
    cpfRepEnte: $('#CPF_REP_ENTE'),
    nomeRepEnte: $('#NOME_REP_ENTE'),
    cargoRepEnte: $('#CARGO_REP_ENTE'),
    emailRepEnte: $('#EMAIL_REP_ENTE'),
    telRepEnte: $('#TEL_REP_ENTE'),

    cpfRepUg: $('#CPF_REP_UG'),
    nomeRepUg: $('#NOME_REP_UG'),
    cargoRepUg: $('#CARGO_REP_UG'),
    emailRepUg: $('#EMAIL_REP_UG'),
    telRepUg: $('#TEL_REP_UG'),

    // etapa 3 CRP
    dataUltCrp: $('#DATA_VENCIMENTO_ULTIMO_CRP'),
    tipoAdm: $('#em_adm'),
    tipoJud: $('#em_jud'),
    grpCrit: $('#grpCRITERIOS'),

    infoDataEncGescon: $('#infoDataEncGescon'),

    // fase 4
    faseRadios: $$('input[name="FASE_PROGRAMA"]'),
    blk41: $('#blk_41'),
    blk42: $('#blk_42'),
    blk43: $('#blk_43'),
    blk44: $('#blk_44'),
    blk45: $('#blk_45'),
    blk46: $('#blk_46'),

    f42Lista: $('#F42_LISTA'),
    f43Lista: $('#F43_LISTA'),
    f44Crits: $('#F44_CRITERIOS'),
    f44Final: $('#F44_FINALIDADES'),
    f46Crits: $('#F46_CRITERIOS'),
    f46Final: $('#F46_FINALIDADES')
  };

  // Util — Bootstrap modal helper
  function showModal(id) {
    const mEl = document.getElementById(id);
    if (!mEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(mEl);
    modal.show();
  }

  function hideModal(id) {
    const mEl = document.getElementById(id);
    if (!mEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(mEl);
    modal.hide();
  }

  function toastAtencao(msg) {
    if (window.app?.showAtencao) {
      window.app.showAtencao([msg]);
    } else {
      console.warn('[ATENÇÃO]', msg);
      showModal('modalAtencao');
      const list = $('#modalAtencaoLista');
      if (list) { list.innerHTML = `<li>${msg}</li>`; }
    }
  }

  // API helpers (ajuste as URLs conforme seu backend/server.js)
  async function postJSON(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function consultarGesconByCnpj(cnpj) {
    // Ex.: /api/gescon/termo-enc
    return postJSON('/api/gescon/termo-enc', { cnpj });
  }

  async function consultarTermosRegistrados(cnpj) {
    // Ex.: /api/termos-registrados
    return postJSON('/api/termos-registrados', { cnpj });
  }

  // Máscara simples de CNPJ (não obrigatória)
  function maskCNPJ(v) {
    return (v || '')
      .replace(/\D/g, '')
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2')
      .slice(0, 18);
  }

  function bindMasks() {
    if (el.cnpjInput) {
      el.cnpjInput.addEventListener('input', () => {
        const sel = el.cnpjInput.selectionStart;
        el.cnpjInput.value = maskCNPJ(el.cnpjInput.value);
        try { el.cnpjInput.setSelectionRange(sel, sel); } catch {}
      });
    }
  }

  // ===== Etapa 0: pesquisar CNPJ e gate TERMO_ENC_GESCON =====
  async function onPesquisar() {
    const cnpj = (el.cnpjInput?.value || '').replace(/\D/g, '');
    if (cnpj.length !== 14) {
      toastAtencao('Informe um CNPJ válido (14 dígitos).');
      return;
    }

    try {
      showModal('modalLoadingSearch');
      const data = await consultarGesconByCnpj(cnpj);
      // Esperado: { cnpj, uf, ente, n_gescon, data_enc_via_gescon }
      const ok = data && data.n_gescon && data.uf && data.ente && data.data_enc_via_gescon;
      if (!ok) {
        el.hasGescon.value = '0';
        hideModal('modalLoadingSearch');
        showModal('modalBusca');
        return;
      }

      // Preenche box informativo
      el.hasGescon.value = '1';
      el.spanNGescon.textContent = data.n_gescon || '';
      el.spanDataEnc.textContent = data.data_enc_via_gescon || '';
      el.spanUfGescon.textContent = data.uf || '';
      el.spanEnteGescon.textContent = data.ente || '';
      el.boxGescon?.classList.remove('d-none');

      // Exibe data do encaminhamento também no título da etapa 1
      if (el.infoDataEncGescon) el.infoDataEncGescon.textContent = data.data_enc_via_gescon || '—';

      hideModal('modalLoadingSearch');

      // Hidratar itens 1–3
      await hidratarTermosRegistrados(cnpj);
    } catch (err) {
      console.error(err);
      hideModal('modalLoadingSearch');
      window.app?.showErro?.(['Falha ao consultar informações. Tente novamente.'])
        || showModal('modalErro');
      const list = $('#modalErroLista');
      if (list) list.innerHTML = '<li>Falha ao consultar informações. Tente novamente.</li>';
    }
  }

  async function hidratarTermosRegistrados(cnpj) {
    try {
      const data = await consultarTermosRegistrados(cnpj);
      // Estrutura flexível — ajuste os nomes conforme o backend
      const ente = data?.ente || {};
      const resp = data?.responsaveis || {};
      const crp = data?.crp || {};

      if (el.uf && ente.uf) el.uf.value = ente.uf;
      if (el.ente && ente.nome) el.ente.value = ente.nome;
      if (el.cnpjEnte && (ente.cnpj || cnpj)) el.cnpjEnte.value = ente.cnpj || cnpj;
      if (el.emailEnte && ente.email) el.emailEnte.value = ente.email;

      if (el.ug && ente.ug) el.ug.value = ente.ug;
      if (el.cnpjUg && ente.cnpj_ug) el.cnpjUg.value = ente.cnpj_ug;
      if (el.emailUg && ente.email_ug) el.emailUg.value = ente.email_ug;

      if (resp.ente) {
        el.cpfRepEnte && (el.cpfRepEnte.value = resp.ente.cpf || '');
        el.nomeRepEnte && (el.nomeRepEnte.value = resp.ente.nome || '');
        el.cargoRepEnte && (el.cargoRepEnte.value = resp.ente.cargo || '');
        el.emailRepEnte && (el.emailRepEnte.value = resp.ente.email || '');
        el.telRepEnte && (el.telRepEnte.value = resp.ente.telefone || '');
      }
      if (resp.ug) {
        el.cpfRepUg && (el.cpfRepUg.value = resp.ug.cpf || '');
        el.nomeRepUg && (el.nomeRepUg.value = resp.ug.nome || '');
        el.cargoRepUg && (el.cargoRepUg.value = resp.ug.cargo || '');
        el.emailRepUg && (el.emailRepUg.value = resp.ug.email || '');
        el.telRepUg && (el.telRepUg.value = resp.ug.telefone || '');
      }

      if (el.dataUltCrp && crp.data_venc) {
        el.dataUltCrp.value = crp.data_venc;
      }
      if (crp.tipo === 'Administrativa' && el.tipoAdm) el.tipoAdm.checked = true;
      if (crp.tipo === 'Judicial' && el.tipoJud) el.tipoJud.checked = true;

      // Se houver lista de critérios (array de strings), podemos marcar em #grpCRITERIOS
      if (Array.isArray(crp.irregulares) && el.grpCrit) {
        // Marcar checkboxes existentes se os values coincidirem
        crp.irregulares.forEach(v => {
          const input = $(`input[name="CRITERIOS_IRREGULARES[]"][value="${CSS.escape(v)}"]`, el.grpCrit);
          if (input) input.checked = true;
        });
      }
    } catch (e) {
      console.warn('Não foi possível hidratar Termos_registrados:', e);
    }
  }

  // ===== Fase 4: exibir blocos de acordo com a opção =====
  function setupFase4Toggles() {
    const map = {
      '4.1': el.blk41,
      '4.2': el.blk42,
      '4.3': el.blk43,
      '4.4': el.blk44,
      '4.5': el.blk45,
      '4.6': el.blk46,
    };

    function showBlock(val) {
      Object.values(map).forEach(b => b && b.classList.add('d-none'));
      const target = map[val];
      if (target) {
        target.classList.remove('d-none');
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    el.faseRadios.forEach(r => r.addEventListener('change', e => showBlock(e.target.value)));
  }

  // ===== Validação quando clica em Próximo (guardar step 0 e 4) =====
  function onNextGuard(e) {
    const btn = el.btnNext;
    if (!btn) return;

    // Se o botão estiver "encaixado" no slot da etapa 0, significa que estamos no passo 0
    if (btn.parentElement && btn.parentElement.id === 'slotNextStep0') {
      if (el.hasGescon.value !== '1') {
        e.preventDefault();
        e.stopPropagation();
        showModal('modalBusca');
        return false;
      }
    }

    // Guard para a etapa 4: requer uma fase selecionada e o respectivo conteúdo válido
    const faseSel = $('input[name="FASE_PROGRAMA"]:checked');
    const anyFaseVisible = [el.blk41, el.blk42, el.blk43, el.blk44, el.blk45, el.blk46]
      .some(b => b && !b.classList.contains('d-none'));

    if (anyFaseVisible) {
      const v = validarFaseSelecionada();
      if (!v.ok) {
        e.preventDefault();
        e.stopPropagation();
        toastAtencao(v.motivo);
        return false;
      }
    }
  }

  function validarFaseSelecionada() {
    const fase = $('input[name="FASE_PROGRAMA"]:checked');
    if (!fase) return { ok: false, motivo: 'Selecione uma fase (4.1 a 4.6).' };

    switch (fase.value) {
      case '4.1': {
        const opt = $('input[name="F41_OPCAO"]:checked', el.blk41);
        if (!opt) return { ok: false, motivo: 'Na fase 4.1, selecione 4.1.1 ou 4.1.2.' };
        return { ok: true };
      }
      case '4.2': {
        const marc = $$('input[type="checkbox"]:checked', el.f42Lista);
        if (!marc.length) return { ok: false, motivo: 'Na fase 4.2, marque ao menos um item (a–g).' };
        return { ok: true };
      }
      case '4.3': {
        const marc = $$('input[type="checkbox"]:checked', el.f43Lista);
        const just = ($('#F43_JUST')?.value || '').trim();
        if (!marc.length && !just) return { ok: false, motivo: 'Na fase 4.3, marque ao menos um critério ou preencha as justificativas.' };
        return { ok: true };
      }
      case '4.4': {
        const crits = $$('input[type="checkbox"]:checked', el.f44Crits);
        if (!crits.length) return { ok: false, motivo: 'Na fase 4.4, selecione ao menos um critério (4.4.1).' };
        return { ok: true };
      }
      case '4.5': {
        const ok451 = $('#blk_45 input[type="checkbox"]:checked');
        const docs = ($('#F45_DOCS')?.value || '').trim();
        const jus = ($('#F45_JUST')?.value || '').trim();
        if (!ok451 && !docs && !jus) return { ok: false, motivo: 'Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas.' };
        return { ok: true };
      }
      case '4.6': {
        const crits = $$('input[type="checkbox"]:checked', el.f46Crits);
        const nivel = $('#F46_PROGESTAO')?.value || '';
        const porte = $('#F46_PORTE')?.value || '';
        if (!crits.length) return { ok: false, motivo: 'Na fase 4.6, selecione ao menos um critério em 4.6.1.' };
        if (!nivel || !porte) return { ok: false, motivo: 'Informe nível Pró-Gestão e Porte ISP-RPPS em 4.6.2.' };
        return { ok: true };
      }
    }
    return { ok: true };
  }

  // ===== Popular listas dinâmicas (opcional) usando os critérios da etapa 3 =====
  function popularListasFaseComBaseNosCritérios() {
    if (!el.grpCrit) return;
    const itens = $$('input[name="CRITERIOS_IRREGULARES[]"]', el.grpCrit).map(inp => ({
      value: inp.value,
      label: inp.nextElementSibling ? inp.nextElementSibling.textContent : inp.value
    }));

    // 4.3 — podemos selecionar um subconjunto mais aderente (exemplo didático: usa todos)
    if (el.f43Lista && !el.f43Lista.children.length) {
      el.f43Lista.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    // 4.4 Critérios objeto do Plano (use todos para permitir marcação)
    if (el.f44Crits && !el.f44Crits.children.length) {
      el.f44Crits.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    // 4.4 Finalidades
    if (el.f44Final && !el.f44Final.children.length) {
      const finals = [
        'Implementação do plano de equacionamento do déficit atuarial',
        'Prazos adicionais para comprovação de medidas',
        'Plano de equacionamento alternativo (art. 55, § 7º, Portaria 1.467/2022)',
        'Adequação da Unidade Gestora Única (CF, art. 40, § 20)',
        'Organização do RPPS / cumprimento de critério estruturante (especificar)'
      ];
      el.f44Final.innerHTML = finals.map(txt => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${txt}"><span class="form-check-label">${txt}</span></label>`
      )).join('');
    }

    // 4.6 Critérios
    if (el.f46Crits && !el.f46Crits.children.length) {
      el.f46Crits.innerHTML = itens.map(it => (
        `<label class="form-check"><input class="form-check-input me-2" type="checkbox" value="${it.value}"><span class="form-check-label">${it.label}</span></label>`
      )).join('');
    }

    // 4.6 Finalidades (mesma lista de 4.4)
    if (el.f46Final && !el.f46Final.children.length) {
      el.f46Final.innerHTML = el.f44Final.innerHTML;
    }
  }

  function init() {
    if (el.btnPesquisar) el.btnPesquisar.addEventListener('click', onPesquisar);
    if (el.btnNext) el.btnNext.addEventListener('click', onNextGuard, true);
    bindMasks();
    setupFase4Toggles();

    // Popular listas dinâmicas após o DOM estar pronto (pega critérios já renderizados da etapa 3)
    popularListasFaseComBaseNosCritérios();

    // Abrir modal de boas-vindas quando existir (seguir mesmo comportamento do de Adesão)
    const mw = $('#modalWelcome');
    if (mw) {
      const wm = bootstrap.Modal.getOrCreateInstance(mw);
      // Apenas abre no primeiro carregamento;
      setTimeout(() => wm.show(), 150);
    }
  }

  // Fallback simples de stepper caso window.app não exista
    function ensureStepperFallback() {
    if (window.app?.stepperReady) return; // já existe um

    const sections = Array.from(document.querySelectorAll('.app-section'));
    const stepsDots = Array.from(document.querySelectorAll('#stepper .step'));
    const btnPrev = document.getElementById('btnPrev');
    const btnNext = document.getElementById('btnNext');
    const btnSubmit = document.getElementById('btnSubmit');
    const slotNextStep0 = document.getElementById('slotNextStep0');

    if (!sections.length || !btnPrev || !btnNext) return;

    let cur = 0;
    function render() {
        sections.forEach((sec, i) => sec.style.display = (i === cur ? '' : 'none'));
        stepsDots.forEach((dot, i) => dot.classList.toggle('active', i === cur));
        btnPrev.style.visibility = cur === 0 ? 'hidden' : 'visible';
        btnNext.classList.toggle('d-none', cur === sections.length - 1);
        btnSubmit.classList.toggle('d-none', !(cur === sections.length - 1));

        // encaixa o Next no slot da etapa 0 (se existir)
        if (slotNextStep0) {
        if (cur === 0 && btnNext.parentElement !== slotNextStep0) {
            slotNextStep0.appendChild(btnNext);
        } else if (cur !== 0 && btnNext.parentElement === slotNextStep0) {
            document.getElementById('navFooter').appendChild(btnNext);
        }
        }
    }
    function next() { if (cur < sections.length - 1) { cur++; render(); } }
    function prev() { if (cur > 0) { cur--; render(); } }

    btnNext.addEventListener('click', next);
    btnPrev.addEventListener('click', prev);

    // expõe flag para não recriar
    window.app = Object.assign(window.app || {}, { stepperReady: true });
    render();
    }


function boot() {
  init();
  ensureStepperFallback(); // sempre depois do init
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
