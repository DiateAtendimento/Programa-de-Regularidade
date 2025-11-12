/* ===========================
   DEBUGADOR SOLIC-CRP v2.0
   =========================== */
(function(){
  const cfg = {
    // 1) escopos e coletores
    rootSel: 'body', // raiz do wizard (pega tudo dentro)
    formSel: 'form#formSolicCrp, form[action*="gerar-solic-crp"]',
    extraFieldSelectors: [
      '[data-name]','[data-field]','[contenteditable="true"]','[role="combobox"]'
    ],
    includeHidden: true,    // captura mesmo se display:none/hidden
    includeDisabled: true,  // captura mesmo se disabled (com status)

    // 2) painel e comportamento
    painel: true,
    baixarArquivos: true,
    interceptarEnvio: true, // intercepta fetch/XHR para LOG e, se ligado, pode coagir tipos
    coagirNoEnvio: false,   // toggle do painel: enviar payload coercedido

    // 3) template PDF
    termoPath: 'termo_solic_crp.html',
    pdfTemplateSelector: '[data-k]',
    storageKey: 'TERMO_SOLIC_CRP_PAYLOAD',

    // 4) tipos esperados pela API
    schemaStringFields: new Set([
      'F41_OPCAO','F41_OPCAO_CODE','F43_PLANO','F43_PLANO_B','F43_INCLUIR','F43_INCLUIR_B',
      'F43_DESC_PLANOS','F441_LEGISLACAO','F445_DESC_PLANOS','F446_DOCS','F446_EXEC_RES',
      'F453_EXEC_RES','F466_DOCS','F466_EXEC_RES','F43_SOLICITA_INCLUSAO','F44_ANEXOS',
      'F45_DOCS','F45_JUST','JUSTIFICATIVAS_GERAIS','PRAZO_ADICIONAL_TEXTO','PRAZO_ADICIONAL_COD'
    ]),
    arrayLikely: new Set([
      'F42_LISTA','F43_LISTA','F44_CRITERIOS','F44_DECLS','F44_FINALIDADES',
      'F46_CRITERIOS','F46_FINALIDADES','F462F_CRITERIOS','CRITERIOS_IRREGULARES',
      'F43_INCLUIR','F43_INCLUIR_B'
    ]),
  };

  // ---------- utils ----------
  const isEmpty = (v) => v==null || (typeof v==='string' && v.trim()==='') ||
                        (Array.isArray(v) && v.length===0) ||
                        (typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===0);

  const sha = async (str)=>{
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
  };

  const toCSV = (rows)=> rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const download = (name,content,mime='text/plain')=>{
    try{ const blob=new Blob([content],{type:mime}); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
    }catch{}
  };

  const getLabelText = (el)=>{
    // tenta label[for], label pai, aria-label, texto próximo
    const id = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (id) return id.textContent.trim();
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent.replace(/\s+/g,' ').trim();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    // fallback: texto do item (ex.: div.role=option)
    return (el.getAttribute('data-label') || '').trim();
  };

  const getOptionText = (sel, val)=>{
    if (!sel) return '';
    const o = [...sel.options].find(op=>op.value==val);
    return o ? (o.textContent||'').trim() : '';
  };

  const visibleOk = (el)=>{
    if (!cfg.includeHidden) {
      const s = getComputedStyle(el);
      if (s.display==='none' || s.visibility==='hidden') return false;
      if (el.closest('[hidden]')) return false;
    }
    return true;
  };

  // ---------- coleta abrangente ----------
  function getAllFieldNodes(){
    const root = document.querySelector(cfg.rootSel) || document.body;
    // pega todos inputs/selects/textareas no root, mesmo ocultos
    const native = [...root.querySelectorAll('input,select,textarea')];
    // pega extras sem name (widgets custom)
    const extras = cfg.extraFieldSelectors.flatMap(sel=> [...root.querySelectorAll(sel)]);
    const all = [...new Set([...native, ...extras])].filter(visibleOk);
    return all;
  }

  function keyFor(el){
    // prioridade: name → data-name → data-field → id
    if (el.name) return el.name;
    const k = el.getAttribute('data-name') || el.getAttribute('data-field') || el.id;
    return k || ''; // pode cair vazio (não agrega)
  }

  function valueOf(el){
    const tag=(el.tagName||'').toLowerCase(), type=(el.type||'').toLowerCase();
    const disabled = el.disabled===true;
    let status = disabled ? 'disabled' : 'enabled';

    if (tag==='select'){
      if (el.multiple){
        const vals = [...el.options].filter(o=>o.selected).map(o=>({value:o.value, label:(o.textContent||'').trim()}));
        return {kind:'select[multiple]', value: vals, status};
      }
      return {kind:'select', value: el.value, label: getOptionText(el, el.value), status};
    }

    if (tag==='textarea'){
      return {kind:'textarea', value: el.value, status};
    }

    if (tag==='input'){
      if (type==='checkbox'){
        return {kind:'checkbox', checked: !!el.checked, value: el.checked ? (el.value||'on') : '', label:getLabelText(el), status};
      }
      if (type==='radio'){
        return {kind:'radio', checked: !!el.checked, value: el.checked ? el.value : '', label:getLabelText(el), name: el.name, status};
      }
      if (type==='date' || type==='number' || type==='time' || type==='email' || type==='tel' || type==='text' || type==='hidden'){
        return {kind:`input:${type||'text'}`, value: el.value, status};
      }
      return {kind:`input:${type||'other'}`, value: el.value, status};
    }

    // widgets custom (contenteditable/combobox etc.)
    if (el.matches('[contenteditable="true"]')){
      return {kind:'contenteditable', value: el.textContent.trim(), status};
    }
    if (el.getAttribute('role')==='combobox'){
      const v = el.getAttribute('data-value') || el.dataset.value || '';
      const txt = el.getAttribute('data-text') || el.dataset.text || el.textContent.trim();
      return {kind:'combobox', value:v, label:txt, status};
    }
    return {kind:'unknown', value: el.value ?? el.textContent?.trim() ?? '', status};
  }

  function snapshotFormDeep(){
    const nodes = getAllFieldNodes();
    const agg = new Map(); // key -> array de valores
    const meta = [];       // lista plana (para tabela)
    const push=(k,rec)=>{ if(!k) return; if(!agg.has(k)) agg.set(k,[]); agg.get(k).push(rec); };

    for (const el of nodes){
      const k = keyFor(el);
      const v = valueOf(el);
      meta.push({key:k||'(sem-chave)', kind:v.kind, status:v.status, value: v.value, label: v.label, checked: v.checked});
      if (!k) continue;

      // agregação por tipo
      if (v.kind==='checkbox'){
        if (v.checked) push(k, v.value || 'on'); else if (!agg.has(k)) push(k, []); // marca grupo não marcado
      } else if (v.kind==='radio'){
        if (v.checked) push(k, v.value); else if (!agg.has(k)) push(k, ''); // grupo sem seleção
      } else if (v.kind==='select[multiple]'){
        push(k, v.value.map(o=>o.value)); // só values no agregado; labels no meta
      } else {
        push(k, v.value);
      }
    }

    // normaliza para objeto (por name)
    const formValues = {};
    for (const [k,arr] of agg.entries()){
      // se só 1 escalar, devolve escalar; se arrays mistos, achata adequadamente
      const flat = arr.flatMap(x => Array.isArray(x) ? [x] : [x]);
      formValues[k] = (flat.length===1 ? flat[0] : flat);
    }

    // Tabela bonita no console com valor+label quando houver
    console.group('🧭 FORM (todas as etapas) — snapshot completo');
    console.table(meta);
    console.groupEnd();

    return {formValues, meta};
  }

  // ---------- payloads ----------
  function coerceForApi(payload){
    const out = {...payload};
    const notes = [];

    // exige string
    for (const key of cfg.schemaStringFields){
      const v = out[key];
      if (Array.isArray(v)){ out[key] = v.join('; '); notes.push({key, from:'array', to:'string', rule:'join("; ")'}); }
      else if (v==null) out[key]='';
    }
    // prováveis arrays
    for (const key of cfg.arrayLikely){
      if (cfg.schemaStringFields.has(key)) continue;
      const v = out[key];
      if (v == null) { out[key] = []; continue; }
      if (!Array.isArray(v)) { out[key] = (v===''?[]:[v]); notes.push({key, from:typeof v, to:'array'}); }
    }
    return {out, notes};
  }

  function verdictTriplo(formValues, payload, posted){
    // posted = realmente enviado (interceptado)
    const namedList = (title, obj)=>{
      const keys = Object.keys(obj||{});
      console.group(title);
      console.table(keys.map(k=>({campo:k, valor: (Array.isArray(obj[k])? JSON.stringify(obj[k]) : obj[k]) })));
      console.groupEnd();
      return keys;
    };

    const fKeys = Object.keys(formValues||{});
    const p1 = Object.keys(payload||{});
    const p2 = Object.keys(posted||{});

    const miss_p1 = fKeys.filter(k=> !p1.includes(k));
    const miss_p2 = fKeys.filter(k=> !p2.includes(k));
    const empt_p1 = p1.filter(k=> isEmpty(payload[k]));
    const empt_p2 = p2.filter(k=> isEmpty(posted?.[k]));
    const diff_p1 = p1.filter(k=> JSON.stringify(payload[k]) !== JSON.stringify(formValues[k]));
    const diff_p2 = p2.filter(k=> JSON.stringify((posted||{})[k]) !== JSON.stringify(formValues[k]));

    console.group('✅ VEREDITO — FORM × buildPayload() × ENVIADO');
    console.info('Faltando no buildPayload:', miss_p1.length, miss_p1);
    console.info('Faltando no ENVIADO   :', miss_p2.length, miss_p2);
    console.info('Vazios no buildPayload:', empt_p1.length, empt_p1);
    console.info('Vazios no ENVIADO     :', empt_p2.length, empt_p2);
    console.info('Diferentes FORM→build :', diff_p1.length, diff_p1);
    console.info('Diferentes FORM→ENVIADO:', diff_p2.length, diff_p2);
    console.groupEnd();

    return {miss_p1, miss_p2, empt_p1, empt_p2, diff_p1, diff_p2};
  }

  // ---------- interceptadores ----------
  let lastPosted = null;
  const originalFetch = window.fetch;
  function patchFetch(){
    if (!cfg.interceptarEnvio || window.__FETCH_PATCHED__) return;
    window.__FETCH_PATCHED__ = true;

    window.fetch = async function(input, init){
      let url = typeof input==='string' ? input : (input?.url || '');
      let method = (init?.method || (typeof input!=='string' ? input.method : '') || 'GET').toUpperCase();
      try{
        if (method==='POST' && init?.body){
          try{
            const body = JSON.parse(init.body);
            lastPosted = {url, method, body};
            console.info('📡 [fetch] POST interceptado →', url, body);
            if (cfg.coagirNoEnvio){
              const {out} = coerceForApi(body);
              init.body = JSON.stringify(out);
              lastPosted = {url, method, body: out, coerced:true};
              console.info('♻️ [fetch] payload coercedido aplicado antes do envio.');
            }
          }catch{}
        }
      }catch{}
      return originalFetch.apply(this, arguments);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  function patchXHR(){
    if (!cfg.interceptarEnvio || window.__XHR_PATCHED__) return;
    window.__XHR_PATCHED__ = true;
    let _url = '', _method = 'GET';
    XMLHttpRequest.prototype.open = function(method, url){
      _url = url; _method = (method||'GET').toUpperCase();
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body){
      try{
        if (_method==='POST' && body){
          try{
            const b = typeof body==='string' ? JSON.parse(body) : body;
            lastPosted = {url:_url, method:_method, body:b};
            console.info('📡 [xhr] POST interceptado →', _url, b);
            if (cfg.coagirNoEnvio){
              const {out} = coerceForApi(b);
              body = JSON.stringify(out);
              lastPosted = {url:_url, method:_method, body: out, coerced:true};
              console.info('♻️ [xhr] payload coercedido aplicado antes do envio.');
            }
          }catch{}
        }
      }catch{}
      return origSend.call(this, body);
    };
  }

  // ---------- painel ----------
  function buildPainel(){
    if (!cfg.painel) return;
    const el = document.createElement('div');
    el.id='debug-solic-crp';
    el.style.cssText = `
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
      background: #0f1220; color:#fff; font: 12px/1.4 system-ui,Segoe UI;
      border: 1px solid #2a2f55; border-radius: 12px; padding: 10px 12px;
      box-shadow: 0 10px 28px rgba(0,0,0,.45); width: 380px; max-height: 70vh; overflow:auto;
    `;
    el.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center;">
        <strong>Debugador SOLIC-CRP v2.0</strong>
        <span id="dbg-badge" style="margin-left:auto;background:#2a2;padding:2px 6px;border-radius:6px;">idle</span>
      </div>
      <div id="dbg-body" style="margin-top:8px; font-size:12px; opacity:.95">
        Pronto. Clique <b>Scan</b> ou apenas preencha que eu capturo.
      </div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button id="dbg-scan" style="flex:1">Scan</button>
        <button id="dbg-dl" style="flex:1">Baixar CSV/JSON</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:8px; align-items:center;">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="dbg-coerce" ${cfg.coagirNoEnvio?'checked':''}>
          <span>Enviar payload coercedido (array→string onde necessário)</span>
        </label>
      </div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button id="dbg-open-termo" style="flex:1">Abrir termo & checar data-k</button>
      </div>
    `;
    document.body.appendChild(el);
    const $ = (s)=> el.querySelector(s);
    $('#dbg-scan').onclick = ()=> runAudit('manual');
    $('#dbg-dl').onclick   = ()=> doDownloads();
    $('#dbg-coerce').onchange = (e)=> { cfg.coagirNoEnvio = e.target.checked; };
    $('#dbg-open-termo').onclick = ()=> openTermoAndCheck();
    styleButtons(el);
  }
  function styleButtons(scope){
    [...scope.querySelectorAll('button')].forEach(b=>{
      b.style.cssText='background:#1b2141;border:1px solid #2a2f55;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer';
      b.onmouseenter = ()=> b.style.background='#212a57';
      b.onmouseleave = ()=> b.style.background='#1b2141';
    });
  }
  function setBadge(text, color='#2a2'){ const b=document.querySelector('#dbg-badge'); if (b){ b.textContent=text; b.style.background=color; } }
  function setBody(html){ const d=document.querySelector('#dbg-body'); if (d) d.innerHTML = html; }

  // ---------- auditoria principal ----------
  let lastAudit = {formValues:null, payload:null, coerced:null, posted:null, diff:null, meta:[]};

  async function runAudit(origin='auto'){
    try{
      setBadge('scan…','#a72');
      // 1) snapshot profundo (todas as etapas e widgets)
      const {formValues, meta} = snapshotFormDeep();

      // 2) buildPayload()
      let payload = {};
      if (typeof window.buildPayload==='function'){
        try { payload = await window.buildPayload(); }
        catch(e){ console.warn('[debug] buildPayload falhou; usando FORM como fallback.', e); payload = {...formValues}; }
      } else payload = {...formValues};

      // 3) coerção para API
      const {out: coerced, notes} = coerceForApi(payload);
      if (notes.length){ console.group('♻️ Coerções para compatibilidade com a API'); console.table(notes); console.groupEnd(); }

      // 4) o que foi realmente ENVIADO (se já houve POST)
      const posted = lastPosted?.body || null;

      // 5) VEREDITO 3-vias
      const diff = verdictTriplo(formValues, payload, posted);

      // 6) resumo no painel
      const filled = Object.entries(formValues).filter(([k,v])=> !isEmpty(v)).length;
      const total = Object.keys(formValues).length;
      setBody(`
        <div><b>Origem:</b> ${origin}</div>
        <div><b>Campos (todas as etapas):</b> ${filled}/${total} preenchidos</div>
        <div><b>Miss build:</b> ${diff.miss_p1.length} | <b>Miss enviado:</b> ${diff.miss_p2.length}</div>
        <div><b>Vazios build:</b> ${diff.empt_p1.length} | <b>Vazios enviado:</b> ${diff.empt_p2.length}</div>
        <div><b>Dif FORM→build:</b> ${diff.diff_p1.length} | <b>Dif FORM→enviado:</b> ${diff.diff_p2.length}</div>
        <div style="margin-top:6px;opacity:.8">Listas completas no console (tabelas nomeadas).</div>
      `);
      setBadge('ok','#2a2');

      lastAudit = {formValues, payload, coerced, posted, diff, meta};
      return lastAudit;
    }catch(e){
      console.error('[debugador v2] falhou', e);
      setBadge('erro','#a22');
    }
  }

  function doDownloads(){
    if (!cfg.baixarArquivos || !lastAudit.formValues) return;
    const rows = [
      ['categoria','campo','detalhe']
    ];
    lastAudit.diff?.miss_p1?.forEach(k => rows.push(['miss_build',k,'não entrou no buildPayload']));
    lastAudit.diff?.miss_p2?.forEach(k => rows.push(['miss_enviado',k,'não entrou no ENVIADO']));
    lastAudit.diff?.empt_p1?.forEach(k => rows.push(['vazio_build',k,'']));
    lastAudit.diff?.empt_p2?.forEach(k => rows.push(['vazio_enviado',k,'']));
    lastAudit.diff?.diff_p1?.forEach(k => rows.push(['dif_form_build',k,'']));
    lastAudit.diff?.diff_p2?.forEach(k => rows.push(['dif_form_enviado',k,'']));
    download('debug_veredito.csv', toCSV(rows), 'text/csv');
    download('form_snapshot.json', JSON.stringify(lastAudit.formValues,null,2), 'application/json');
    download('payload_build.json', JSON.stringify(lastAudit.payload,null,2), 'application/json');
    download('payload_coercido.json', JSON.stringify(lastAudit.coerced,null,2), 'application/json');
    if (lastAudit.posted) download('payload_enviado.json', JSON.stringify(lastAudit.posted,null,2), 'application/json');
    download('form_meta_todas_etapas.json', JSON.stringify(lastAudit.meta,null,2), 'application/json');
  }

  // ---------- termo & data-k ----------
  async function openTermoAndCheck(){
    try{
      const audit = lastAudit.formValues ? lastAudit : await runAudit('open-termo');
      const payload = cfg.coagirNoEnvio ? audit.coerced : audit.payload;
      const jsonStr = JSON.stringify(payload);
      sessionStorage.setItem(cfg.storageKey, jsonStr);

      const w = window.open(cfg.termoPath + '#debug', '_blank');
      if (!w){ alert('Pop-up bloqueado. Permita pop-ups.'); return; }

      // aguarda carregar
      const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
      for (let i=0;i<60;i++){ if (w.document && w.document.readyState==='complete') break; await sleep(100); }

      // coleta data-k no termo
      const nodes = w.document.querySelectorAll(cfg.pdfTemplateSelector);
      if (!nodes.length){
        console.info('Termo aberto, mas sem [data-k] visível.');
        return;
      }
      const tplKeys = [...new Set([...nodes].map(n => (n.getAttribute('data-k')||'').split('|')[0].trim()).filter(Boolean))].sort();
      const pKeys = Object.keys(payload).sort();
      const tplMissing = tplKeys.filter(k=> !pKeys.includes(k));
      const tplExtras  = pKeys.filter(k=> !tplKeys.includes(k));

      console.group('📄 TERMO (data-k) vs Payload');
      console.info('data-k faltando no payload → virarão "Não informado":', tplMissing.length, tplMissing);
      console.info('chaves no payload sem data-k no template:', tplExtras.length, tplExtras);
      console.groupEnd();
    }catch(e){
      console.error('[openTermoAndCheck] erro', e);
    }
  }

  // ---------- instalação ----------
  function install(){
    buildPainel();
    if (cfg.interceptarEnvio){ patchFetch(); patchXHR(); }

    // disparos leves
    const form = document.querySelector(cfg.formSel) || document.querySelector('form');
    let t=null;
    (form||document).addEventListener('change', ()=>{ clearTimeout(t); t=setTimeout(()=>runAudit('change'), 120); });
    (form||document).addEventListener('input',  ()=>{ clearTimeout(t); t=setTimeout(()=>runAudit('input'), 150); });

    runAudit('auto');
  }

  // API pública
  window.SolicCrpDebugger = { install, runAudit, doDownloads, openTermoAndCheck,
    setCoagir:(on)=> cfg.coagirNoEnvio=!!on };

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
