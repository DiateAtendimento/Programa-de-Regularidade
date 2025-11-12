/* ===========================
   DEBUGADOR SOLIC-CRP v1.0
   =========================== */
(function(){
  const cfg = {
    formSel: 'form#formSolicCrp, form[action*="gerar-solic-crp"]',
    painel: true,                // mostra painel flutuante
    baixarArquivos: true,        // baixa CSV/JSON ao submeter
    storageKey: 'TERMO_SOLIC_CRP_PAYLOAD',
    pdfTemplateSelector: '[data-k]', // se o termo expuser data-k
    schemaStringFields: new Set([
      // Campos que a API espera como string (evita o 400 do F43_INCLUIR)
      'F41_OPCAO','F41_OPCAO_CODE','F43_PLANO','F43_PLANO_B','F43_INCLUIR','F43_INCLUIR_B',
      'F43_DESC_PLANOS','F441_LEGISLACAO','F445_DESC_PLANOS','F446_DOCS','F446_EXEC_RES',
      'F453_EXEC_RES','F466_DOCS','F466_EXEC_RES','F43_SOLICITA_INCLUSAO','F44_ANEXOS',
      'F45_DOCS','F45_JUST','JUSTIFICATIVAS_GERAIS','PRAZO_ADICIONAL_TEXTO','PRAZO_ADICIONAL_COD'
    ]),
    // Campos que normalmente são listas/multiselect/checkbox group
    arrayLikely: new Set([
      'F42_LISTA','F43_LISTA','F44_CRITERIOS','F44_DECLS','F44_FINALIDADES',
      'F46_CRITERIOS','F46_FINALIDADES','F462F_CRITERIOS','CRITERIOS_IRREGULARES',
      'F43_INCLUIR','F43_INCLUIR_B' // podem vir de checkboxes; serão convertidos c/ aviso
    ]),
  };

  const isEmpty = (v) => v==null || (typeof v==='string' && v.trim()==='') ||
                        (Array.isArray(v) && v.length===0) ||
                        (typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===0);

  function getForm(){
    return document.querySelector(cfg.formSel) || document.querySelector('form');
  }

  function snapshotForm(form){
    const byName = new Map();
    const push=(k,v)=>{ if(!k) return; if(!byName.has(k)) byName.set(k,[]); byName.get(k).push(v); };

    const fields = [...form.querySelectorAll('input,select,textarea')];
    for (const el of fields){
      if (!el.name || el.disabled) continue;
      const tag = (el.tagName||'').toLowerCase();
      const type = (el.type||'').toLowerCase();

      if (tag==='select'){
        if (el.multiple){
          const vals = [...el.options].filter(o=>o.selected).map(o=>o.value);
          push(el.name, vals);
        } else {
          push(el.name, el.value);
        }
      } else if (tag==='textarea'){
        push(el.name, el.value);
      } else if (tag==='input'){
        if (type==='checkbox'){
          if (el.checked) push(el.name, el.value || 'on');
          else if (!byName.has(el.name)) push(el.name, []); // marca como não marcado
        } else if (type==='radio'){
          if (el.checked) push(el.name, el.value);
          else if (!byName.has(el.name)) push(el.name, ''); // grupo ainda sem check
        } else {
          push(el.name, el.value);
        }
      }
    }

    const result = {};
    for (const [k,arr] of byName.entries()){
      // normaliza: se só há um valor escalar, devolve escalar
      result[k] = (arr.length===1 ? arr[0] : arr);
    }
    return result;
  }

  function coerceForApi(payload){
    const out = {...payload};
    const notes = [];

    // Campos que a API exige string → se vier array, junta por '; ' e avisa
    for (const key of cfg.schemaStringFields){
      const v = out[key];
      if (Array.isArray(v)){
        out[key] = v.join('; ');
        notes.push({key, from:'array', to:'string', rule:'join("; ")'});
      } else if (v == null){
        out[key] = '';
      }
    }

    // Para campos “array prováveis”, garanta array (salvo se API exigir string)
    for (const key of cfg.arrayLikely){
      if (cfg.schemaStringFields.has(key)) continue; // já tratado acima
      const v = out[key];
      if (v == null) { out[key] = []; continue; }
      if (!Array.isArray(v)) { out[key] = (v===''?[]:[v]); notes.push({key, from:typeof v, to:'array'}); }
    }

    return {out, notes};
  }

  function toCSV(rows){
    return rows.map(r=>r.map(v=> `"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  }
  function download(name, content, mime='text/plain'){
    try{
      const blob=new Blob([content],{type:mime}); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
    }catch{}
  }

  function buildPainel(){
    if (!cfg.painel) return null;
    const el = document.createElement('div');
    el.id='debug-solic-crp';
    el.style.cssText = `
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
      background: #111; color:#fff; font: 12px/1.4 system-ui,Segoe UI,Arial;
      border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 20px rgba(0,0,0,.35);
      max-width: 380px; width: 360px;
    `;
    el.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center;">
        <strong style="font-size:13px;">Debugador SOLIC-CRP</strong>
        <span id="dbg-badge" style="margin-left:auto;background:#2a2;padding:2px 6px;border-radius:6px;">idle</span>
      </div>
      <div id="dbg-body" style="margin-top:8px; max-height: 250px; overflow:auto;">
        <div>Use o console para detalhes (tabelas). Aqui vai um resumo rápido.</div>
      </div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button id="dbg-scan" style="flex:1">Scan</button>
        <button id="dbg-dl" style="flex:1">Baixar CSV/JSON</button>
      </div>
    `;
    document.body.appendChild(el);
    const btn = el.querySelector('#dbg-scan');
    const dl  = el.querySelector('#dbg-dl');
    btn.onclick = () => runAudit('manual');
    dl.onclick  = () => doDownloads();
    // estilos mínimos
    [...el.querySelectorAll('button')].forEach(b=>{
      b.style.cssText = 'background:#333;border:1px solid #555;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer';
      b.onmouseenter = ()=> b.style.background='#444';
      b.onmouseleave = ()=> b.style.background='#333';
    });
    return el;
  }

  function setBadge(text, color='#2a2'){
    const b = document.querySelector('#dbg-badge');
    if (b){ b.textContent = text; b.style.background = color; }
  }
  function setBody(html){
    const d = document.querySelector('#dbg-body');
    if (d){ d.innerHTML = html; }
  }

  function relatarForm(formValues){
    const linhas = [];
    Object.keys(formValues).sort().forEach(k=>{
      const v = formValues[k];
      const status = isEmpty(v) ? 'vazio/nao preenchido' :
                     Array.isArray(v) ? (v.length ? 'selecionado (multi)' : 'vazio/nao preenchido')
                                       : (String(v).trim()===''?'vazio/nao preenchido':'preenchido');
      linhas.push({campo:k, valor: Array.isArray(v)? JSON.stringify(v): v, status});
    });
    console.group('📝 FORM — tudo que foi marcado/selecionado/preenchido');
    console.table(linhas);
    console.groupEnd();

    const resumo = {
      total_campos: linhas.length,
      preenchidos: linhas.filter(r=>r.status==='preenchido' || r.status==='selecionado (multi)').length,
      vazios: linhas.filter(r=>r.status==='vazio/nao preenchido').length
    };
    return {linhas, resumo};
  }

  function diffFormPayload(formValues, payload){
    const fKeys = Object.keys(formValues).sort();
    const pKeys = Object.keys(payload).sort();
    const missingInPayload = fKeys.filter(k=> !pKeys.includes(k));
    const emptiesInPayload = pKeys.filter(k=> isEmpty(payload[k]));
    const typeMismatches   = pKeys
      .filter(k=> k in formValues)
      .map(k=> ({k, f:Array.isArray(formValues[k])?'array':typeof formValues[k],
                    p:Array.isArray(payload[k])?'array':typeof payload[k]}))
      .filter(x=> x.f !== x.p);

    console.group('🔎 DIFERENÇAS — FORM × PAYLOAD');
    if (missingInPayload.length){
      console.table(missingInPayload.map(k=>({campo:k, status:'não entrou no payload'})));
    } else {
      console.info('Nenhum campo do FORM ficou de fora do payload.');
    }
    if (emptiesInPayload.length){
      console.table(emptiesInPayload.map(k=>({campo:k, status:'valor vazio/indefinido no payload'})));
    }
    if (typeMismatches.length){
      console.table(typeMismatches);
    }
    console.groupEnd();

    return {missingInPayload, emptiesInPayload, typeMismatches};
  }

  function checkPdfTemplateKeys(payload){
    const nodes = document.querySelectorAll(cfg.pdfTemplateSelector);
    if (!nodes.length){
      console.info('Template PDF sem [data-k] visível — confronto DOM do termo desativado.');
      return {tplKeys:[], tplMissing:[], tplExtras:[]};
    }
    const tplKeys = [...new Set([...nodes]
      .map(n => (n.getAttribute('data-k')||'').split('|')[0].trim())
      .filter(Boolean)
    )].sort();
    const pKeys = Object.keys(payload).sort();
    const tplMissing = tplKeys.filter(k=> !pKeys.includes(k));
    const tplExtras  = pKeys.filter(k=> !tplKeys.includes(k));

    console.group('📄 TEMPLATE (termo_solic_crp.html) — confronto com payload');
    console.info(`data-k encontrados: ${tplKeys.length}`);
    if (tplMissing.length) console.table(tplMissing.map(k=>({key:k,status:'faltou_no_payload → vira "Não informado"'})));
    if (tplExtras.length)  console.table(tplExtras.map(k=>({key:k,status:'extra_no_template'})));
    console.groupEnd();

    return {tplKeys, tplMissing, tplExtras};
  }

  // Mantemos referências para downloads no painel
  let lastAudit = {formValues:null, payload:null, coerced:null,
                   linhasForm:[], resumoForm:null, diff:null, tpl:null};

  async function runAudit(origin='auto'){
    try{
      setBadge('auditing…','#a72');
      const form = getForm();
      if (!form){ setBody('Formulário não encontrado.'); setBadge('no-form','#a22'); return; }

      // 1) Foto do FORM
      const formValues = snapshotForm(form);
      const {linhas, resumo} = relatarForm(formValues);

      // 2) Payload oficial (ou fallback)
      let payload = {};
      if (typeof window.buildPayload === 'function'){
        try { payload = await window.buildPayload(); }
        catch(e){ console.warn('[debug] buildPayload falhou, usando FORM como fallback.', e); payload = {...formValues}; }
      } else {
        payload = {...formValues};
      }

      // 3) Coerção para a API (evita 400 em campos string)
      const {out: coerced, notes} = coerceForApi(payload);
      if (notes.length){
        console.group('♻️ Coerções aplicadas para compatibilidade com a API');
        console.table(notes);
        console.groupEnd();
      }

      // 4) Diff
      const diff = diffFormPayload(formValues, payload);

      // 5) (Opcional) Confronto com template PDF (se termo tiver data-k no DOM atual)
      const tpl = checkPdfTemplateKeys(payload);

      // 6) Resumo no painel
      setBody(`
        <div><b>Origem:</b> ${origin}</div>
        <div><b>Total campos:</b> ${resumo.total_campos}</div>
        <div><b>Preenchidos / Vazios:</b> ${resumo.preenchidos} / ${resumo.vazios}</div>
        <div><b>Faltando no payload:</b> ${diff.missingInPayload.length}</div>
        <div><b>Vazios no payload:</b> ${diff.emptiesInPayload.length}</div>
        <div><b>Type mismatches:</b> ${diff.typeMismatches.length}</div>
        <div><b>Template data-k (se houver):</b> faltou=${tpl.tplMissing?.length||0} extra=${tpl.tplExtras?.length||0}</div>
        <div style="margin-top:6px;opacity:.8">Detalhes no console (tables).</div>
      `);
      setBadge('ok','#2a2');

      lastAudit = {formValues, payload, coerced, linhasForm:linhas, resumoForm:resumo, diff, tpl};
      return lastAudit;
    }catch(e){
      console.error('[debugador] falhou', e);
      setBadge('erro','#a22');
    }
  }

  function doDownloads(){
    if (!cfg.baixarArquivos || !lastAudit.payload) return;
    const rows = [['campo','status']];
    lastAudit.diff?.missingInPayload?.forEach(k => rows.push([k,'nao_enviado']));
    lastAudit.diff?.emptiesInPayload?.forEach(k => rows.push([k,'vazio_no_payload']));
    lastAudit.diff?.typeMismatches?.forEach(x => rows.push([x.k,`type: form=${x.f} → payload=${x.p}`]));
    lastAudit.tpl?.tplMissing?.forEach(k => rows.push([k,'faltou_no_payload(template)']));
    lastAudit.tpl?.tplExtras?.forEach(k => rows.push([k,'extra_no_template']));

    download('relatorio_debug_solic_crp.csv', toCSV(rows), 'text/csv');
    download('payload_original.json', JSON.stringify(lastAudit.payload, null, 2), 'application/json');
    download('payload_coercido.json', JSON.stringify(lastAudit.coerced, null, 2), 'application/json');
    download('form_snapshot.json', JSON.stringify(lastAudit.formValues, null, 2), 'application/json');
  }

  // Instala hooks: roda a cada mudança e antes do submit
  function install(){
    buildPainel();
    const form = getForm();
    if (!form) return;

    // Audit leve a cada change (debounced)
    let t=null;
    form.addEventListener('change', ()=>{ clearTimeout(t); t=setTimeout(()=>runAudit('change'), 100); });
    form.addEventListener('input',  ()=>{ clearTimeout(t); t=setTimeout(()=>runAudit('input'), 150); });

    // Hook no submit: valida e mostra tudo; opcionalmente substitui payload por versão “coercida”
    form.addEventListener('submit', async (ev)=>{
      try{
        const audit = await runAudit('submit');
        // Mostra campos críticos comuns
        const crits = ['DATA_VENC_ULTIMO_CRP','TIPO_EMISSAO_ULTIMO_CRP','PRAZO_ADICIONAL_COD','PRAZO_ADICIONAL_TEXTO','FASE_PROGRAMA'];
        const show = {};
        crits.forEach(k => show[k] = audit?.payload?.[k]);
        console.info('[SUBMIT] campos críticos →', show);

        // Evita 400 se algum dos campos que a API quer string veio como array
        const violations = [];
        for (const k of cfg.schemaStringFields){
          const v = audit?.payload?.[k];
          if (Array.isArray(v)) violations.push(k);
        }
        if (violations.length){
          console.warn('[SUBMIT] corrigindo campos que a API exige string (join "; ") →', violations);
        }

        // expõe coerção no window para quem usa postJSON (caso necessário)
        window.__DEBUG_PAYLOAD_COERCIDO__ = audit.coerced;

        // OPCIONAL: se você quiser enviar o payload já coercido, remova o comentário abaixo
        // ev.preventDefault();
        // enviarComCoercao(audit.coerced);

        if (cfg.baixarArquivos) doDownloads();
      }catch(e){
        console.error('[SUBMIT][ERRO] ', e);
      }
    }, true);

    // Primeira foto
    runAudit('auto');
  }

  // Exemplo de envio com coerção (caso queira adotar)
  async function enviarComCoercao(payload){
    // Ajuste aqui para usar seu postJSON; abaixo só demonstração:
    const url = '/_api/gerar-solic-crp';
    const res = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
    if (!res.ok){
      const txt = await res.text();
      throw new Error(`HTTP ${res.status} — ${txt}`);
    }
    return res.json();
  }

  // API pública
  window.SolicCrpDebugger = { install, runAudit, doDownloads };

  // instala automático após DOM pronto
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
