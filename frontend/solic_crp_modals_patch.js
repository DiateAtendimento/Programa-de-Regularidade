// Patch: coleta robusta de modais/fases + proteção no submit
// Aplicar este arquivo adiciona funções auxiliares que tornam a captura
// de seleções em modais/fases mais robusta e protege o fluxo de submit
// contra layouts que não possuam o botão #btnSubmit.

(function(){
  // Collect utilities for robust extraction of selected values from
  // modals, legacy containers and multiple possible selectors.
  function collectFromSelectors(selectors){
    // Recebe array de seletores; retorna array único de valores (strings) sem duplicatas
    const arr = (selectors || []).flatMap(sel => {
      try{
        return Array.from(document.querySelectorAll(sel || ''));
      }catch{
        return [];
      }
    }).filter(Boolean);

    const values = arr.map(el => {
      if(!el) return '';
      // prioridade: value (inputs), data-value, dataset.label, atributo value, texto visível
      const v = (el.value || el.dataset?.value || el.dataset?.label || el.getAttribute('value') || '').toString().trim();
      if (v) return v;
      const txt = (el.dataset?.label || el.title || (el.nextElementSibling && el.nextElementSibling.innerText) || el.innerText || '').toString().trim();
      return txt;
    }).filter(Boolean);

    // retorna sem duplicatas e mantendo ordem de aparição
    return Array.from(new Set(values));
  }

  // Exemplo de funções que o integrador pode chamar antes de montar o payload
  window.__collectFaseLists = function(){
    const F42_LISTA = collectFromSelectors([
      '#F42_LISTA input[type="checkbox"]:checked',
      'input[name="F42_ITENS[]"]:checked',
      '#modalF42 input[type="checkbox"]:checked',
      '#modalF42 [data-prz]:checked'
    ]);

    const F43_LISTA = collectFromSelectors([
      '#F43_LISTA input[type="checkbox"]:checked',
      'input[name="F43_LISTA[]"]:checked',
      '#modalF43 input[type="checkbox"]:checked'
    ]);

    const F44_CRITERIOS = collectFromSelectors([
      '#F44_CRITERIOS input[type="checkbox"]:checked',
      'input[name="F44_CRITERIOS[]"]:checked',
      '#modalF44 input[type="checkbox"]:checked'
    ]);

    const F44_DECLS = collectFromSelectors([
      '#blk_44 .d-flex input[type="checkbox"]:checked',
      'input[name="F44_DECLS[]"]:checked',
      '#modalF44 .d-flex input[type="checkbox"]:checked'
    ]);

    const F44_FINALIDADES = collectFromSelectors([
      '#F44_FINALIDADES input[type="checkbox"]:checked',
      'input[name="F44_FINALIDADES[]"]:checked',
      '#modalF44 input[name="F44_FINALIDADES[]"]:checked'
    ]);

    const F46_CRITERIOS = collectFromSelectors([
      '#F46_CRITERIOS input[type="checkbox"]:checked',
      'input[name="F46_CRITERIOS[]"]:checked',
      '#modalF46 input[type="checkbox"]:checked'
    ]);

    return {
      F42_LISTA, F43_LISTA, F44_CRITERIOS, F44_DECLS, F44_FINALIDADES, F46_CRITERIOS
    };
  };

  // Proteção simples para desabilitar o botão de submit (quando presente)
  window.__protectDisableSubmit = function(){
    const btn = document.getElementById('btnSubmit') || document.querySelector('[type="submit"]');
    const old = btn ? (btn.innerHTML || '') : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Finalizando…'; }
    return function restore(){ if (btn) { btn.disabled = false; btn.innerHTML = old; } };
  };

  // Debug helper (ativa com window.__DEBUG_SOLIC_CRP__ = true)
  window.__debugFaseLists = function(lists){
    if (!window.__DEBUG_SOLIC_CRP__) return;
    console.log('[solic_crp DEBUG] F42_LISTA', lists.F42_LISTA);
    console.log('[solic_crp DEBUG] F43_LISTA', lists.F43_LISTA);
    console.log('[solic_crp DEBUG] F44_CRITERIOS', lists.F44_CRITERIOS);
    console.log('[solic_crp DEBUG] F46_CRITERIOS', lists.F46_CRITERIOS);
  };

  // Instruções de uso rápido (comentadas; quem aplicar pode descomentar/usar):
  // const restore = window.__protectDisableSubmit();
  // const lists = window.__collectFaseLists();
  // window.__debugFaseLists(lists);
  // // montar payload aqui
  // restore();

})();