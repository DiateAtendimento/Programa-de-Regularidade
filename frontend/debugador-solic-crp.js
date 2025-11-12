<!-- debugador-solic-crp.js v2.2 -->
<script>
/* ===========================
   DEBUGADOR SOLIC-CRP v2.2
   =========================== */
(function(){
  const cfg = {
    // 1) escopos e coletores
    rootSel: 'body',
    formSel: 'form#formSolicCrp, form[action*="gerar-solic-crp"]',
    extraFieldSelectors: ['[data-name]','[data-field]','[contenteditable="true"]','[role="combobox"]'],
    includeHidden: true,
    includeDisabled: true,

    // 2) painel e comportamento
    painel: true,
    baixarArquivos: true,
    interceptarEnvio: true,
    coagirNoEnvio: false,   // pode ativar no painel

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
      'ESFERA_GOVERNO','CRITERIOS_IRREGULARES',
      'F42_LISTA','F43_LISTA','F44_CRITERIOS','F44_DECLS','F44_FINALIDADES',
      'F45_CONDICOES','F46_CONDICOES','F46_CRITERIOS','F46_FINALIDADES',
      'F462_FINALIDADES','F462F_CRITERIOS','F43_INCLUIR','F43_INCLUIR_B'
    ]),
  };

  // --------- canonização de chaves ----------
  const CANON_MAP = new Map([
    // [] → base
    ['ESFERA_GOVERNO[]','ESFERA_GOVERNO'],
    ['CRITERIOS_IRREGULARES[]','CRITERIOS_IRREGULARES'],
    ['F42_LISTA[]','F42_LISTA'],['F43_LISTA[]','F43_LISTA'],
    ['F44_CRITERIOS[]','F44_CRITERIOS'],['F44_DECLS[]','F44_DECLS'],['F44_FINALIDADES[]','F44_FINALIDADES'],
    ['F45_CONDICOES[]','F45_CONDICOES'],['F46_CONDICOES[]','F46_CONDICOES'],
    ['F46_CRITERIOS[]','F46_CRITERIOS'],['F46_FINALIDADES[]','F46_FINALIDADES'],
    ['F462_FINALIDADES[]','F462_FINALIDADES'],['F462F_CRITERIOS[]','F462F_CRITERIOS'],
    ['F43_INCLUIR[]','F43_INCLUIR'],['F43_INCLUIR_B[]','F43_INCLUIR_B'],

    // duplicatas típicas
    ['ULTIMO_CRP_DATA','DATA_VENC_ULTIMO_CRP'],
    ['ULTIMO_CRP_TIPO','TIPO_EMISSAO_ULTIMO_CRP'],
    ['data_vencimento_ultimo_crp','DATA_VENC_ULTIMO_CRP'],
    ['data_venc_ultimo_crp','DATA_VENC_ULTIMO_CRP'],
    ['venc_ult_crp','DATA_VENC_ULTIMO_CRP'],
    ['tipo_emissao_ult_crp','TIPO_EMISSAO_ULTIMO_CRP'],

    // prazo adicional lower → upper
    ['prazo_adicional_cod','PRAZO_ADICIONAL_COD'],
    ['prazo_adicional_texto','PRAZO_ADICIONAL_TEXTO'],
  ]);

  const canon = (k)=>{
    if (!k) return '';
    let out = String(k).trim().replace(/\[\]+$/,'[]'); // "[][]" → "[]"
    if (CANON_MAP.has(out)) return CANON_MAP.get(out);
    if (/\[\]$/.test(out)) out = out.slice(0,-2);
    return out;
  };

  const normalizeObjKeys = (obj)=>{
    if (!obj || typeof obj!=='object') return obj;
    const out = {};
    for (const [k,v] of Object.entries(obj)){
      const ck = canon(k);
      if (!(ck in out)) out[ck] = v;
      else {
        const cur = out[ck];
        if (Array.isArray(cur) && Array.isArray(v)) out[ck] = [...cur, ...v];
        else if (Array.isArray(cur)) out[ck] = [...cur, v];
        else if (Array.isArray(v)) out[ck] = [cur, ...v];
        else out[ck] = (cur===v ? cur : [cur, v]);
      }
    }
    return out;
  };

  // ---------- utils ----------
  const isEmpty = (v)=> v==null || (typeof v==='string' && v.trim()==='') ||
                       (Array.isArray(v) && v.length===0) ||
                       (typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===0);

  const toCSV = (rows)=> rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const download = (name,content,mime='text/plain')=>{
    try{ const blob=new Blob([content],{type:mime}); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
    }catch{}
  };

  const getLabelText = (el)=>{
    const labById = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labById) return labById.textContent.trim();
    const wrap = el.closest('label'); if (wrap) return wrap.textContent.replace(/\s+/g,' ').trim();
    const aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
    return (el.getAttribute('data-label') || '').trim();
  };

  const getOptionText = (sel,val)=>{
    const o = sel && [...sel.options].find(op=>op.value==val);
    return o ? (o.textContent||'').trim() : '';
  };

  const visibleOk = (el)=>{
    if (!cfg.includeHidden){
      const s=getComputedStyle(el);
      if (s.display==='none'||s.visibility==='hidden') return false;
      if (el.closest('[hidden]')) return false;
    }
    return true;
  };

  // ---------- coleta abrangente ----------
  function getAllFieldNodes(){
    const root = document.querySelector(cfg.rootSel) || document.body;
    const native = [...root.querySelectorAll('input,select,textarea')];
    const extras = cfg.extraFieldSelectors.flatMap(sel=> [...root.querySelectorAll(sel)]);
    const all = [...new Set([...native, ...extras])].filter(visibleOk);
    return all;
  }

  function keyFor(el){
    if (el.name) return canon(el.name);
    const k = el.getAttribute('data-name') || el.getAttribute('data-field') || el.id || '';
    return canon(k);
  }

  function valueOf(el){
    const tag=(el.tagName||'').toLowerCase(), type=(el.type||'').toLowerCase();
    const disabled = el.disabled===true;
    let status = disabled? 'disabled':'enabled';

    if (tag==='select'){
      if (el.multiple){
        const vals = [...el.options].filter(o=>o.selected).map(o=>({value:o.value, label:(o.textContent||'').trim()}));
        return {kind:'select[multiple]', value: vals, status};
      }
      return {kind:'select', value: el.value, label:getOptionText(el, el.value), status};
    }
    if (tag==='textarea') return {kind:'textarea', value: el.value, status};

    if (tag==='input'){
      if (type==='checkbox') return {kind:'checkbox', checked:!!el.checked, value: el.checked?(el.value||'on'):'', label:getLabelText(el), status};
      if (type==='radio')    return {kind:'radio',    checked:!!el.checked, value: el.checked? el.value:'', label:getLabelText(el), name:el.name, status};
      return {kind:`input:${type||'text'}`, value: el.value, status};
    }

    if (el.matches('[contenteditable="true"]')){
      return {kind:'contenteditable', value: el.textContent.trim(), status};
    }
    if (el.getAttribute('role')==='combobox'){
      const v = el.getAttribute('data-value') || el.dataset.value || '';
      const txt= el.getAttribute('data-text')  || el.dataset.text  || el.textContent.trim();
      return {kind:'combobox', value:v, label:txt, status};
    }
    return {kind:'unknown', value: el.value ?? el.textContent?.trim() ?? '', status};
  }

  function snapshotFormDeep(){
    const nodes = getAllFieldNodes();
    const agg = new Map();
    const meta = [];
    const push=(k,rec)=>{ if(!k) return; if(!agg.has(k)) agg.set(k,[]); agg.get(k).push(rec); };

    for (const el of nodes){
      const k = keyFor(el);
      const v = valueOf(el);
      meta.push({key:k||'(sem-chave)', kind:v.kind, status:v.status, value: v.value, label: v.label, checked: v.checked});
      if (!k) continue;

      if (v.kind==='checkbox'){
        if (v.checked) push(k, v.value||'on'); else if (!agg.has(k)) push(k, []);
      } else if (v.kind==='radio'){
        if (v.checked) push(k, v.value); else if (!agg.has(k)) push(k, '');
      } else if (v.kind==='select[multiple]'){
        push(k, v.value.map(o=>o.value));
      } else {
        push(k, v.value);
      }
    }

    const formValues = {};
    for (const [k,arr] of agg.entries()){
      const flat = arr.flatMap(x => Array.isArray(x) ? [x] : [x]);
      formValues[k] = (flat.length===1 ? flat[0] : flat);
    }

    console.group('🧭 FORM (todas as etapas) — snapshot completo');
    console.table(meta);
    console.groupEnd();
    return {formValues, meta};
  }

  // ---------- payloads ----------
  function coerceForApi(payload){
    const out = {...payload};
    const notes = [];

    for (const key of cfg.schemaStringFields){
      const v = out[key];
      if (Array.isArray(v)){ out[key] = v.join('; '); notes.push({key, from:'array', to:'string', rule:'join("; ")'}); }
      else if (v==null) out[key]='';
    }
    for (const key of cfg.arrayLikely){
      if (cfg.schemaStringFields.has(key)) continue;
      const v = out[key];
      if (v == null) { out[key] = []; continue; }
      if (!Array.isArray(v)) { out[key] = (v===''?[]:[v]); notes.push({key, from:typeof v, to:'array'}); }
    }
    return {out, notes};
  }

  // ---------- resumo humano para o console ----------
  function ensureArray(x){ return Array.isArray(x) ? x : (x==null||x===''? [] : [x]); }

  function humanSummary(source, title='📋 RESUMO HUMANO — dados principais'){
    const p = normalizeObjKeys(source||{});

    const resumo = [
      {sec:'Identificação do Ente',
        ENTE: p.ENTE, UF: p.UF, ESFERA: (ensureArray(p.ESFERA_GOVERNO)||[]).join(' / '),
        CNPJ_ENTE: p.CNPJ_ENTE, EMAIL_ENTE: p.EMAIL_ENTE,
        UG: p.UG||p.ug_nome, CNPJ_UG: p.CNPJ_UG||p.ug_cnpj, EMAIL_UG: p.EMAIL_UG||p.ug_email,
        ORGAO_VINC_UG: p.ORGAO_VINCULACAO_UG||p.ug_orgao_vinc
      },
      {sec:'Representantes',
        REP_ENTE: `${p.NOME_REP_ENTE||''} | CPF ${p.CPF_REP_ENTE||''} | ${p.CARGO_REP_ENTE||''} | ${p.EMAIL_REP_ENTE||''} | ${p.TEL_REP_ENTE||''}`,
        REP_UG  : `${p.NOME_REP_UG||''} | CPF ${p.CPF_REP_UG||''} | ${p.CARGO_REP_UG||''} | ${p.EMAIL_REP_UG||''} | ${p.TEL_REP_UG||''}`
      },
      {sec:'CRP anterior',
        DATA_VENC_ULTIMO_CRP: p.DATA_VENC_ULTIMO_CRP||p.ULTIMO_CRP_DATA,
        TIPO_EMISSAO_ULTIMO_CRP: p.TIPO_EMISSAO_ULTIMO_CRP||p.ULTIMO_CRP_TIPO
      },
      {sec:'Programa / Fase / Prazos',
        FASE_PROGRAMA: p.FASE_PROGRAMA||p.__FASE_SEL__,
        PRAZO_ADICIONAL_COD: p.PRAZO_ADICIONAL_COD,
        PRAZO_ADICIONAL_TEXTO: p.PRAZO_ADICIONAL_TEXTO,
        PRAZO_ADICIONAL_FLAG: p.PRAZO_ADICIONAL_FLAG
      },
      {sec:'Critérios Irregulares',
        CRITERIOS_IRREGULARES: ensureArray(p.CRITERIOS_IRREGULARES).join(' | ')
      },
      {sec:'F46 — Finalidades & Decls & Condições',
        F46_FINALIDADES: ensureArray(p.F46_FINALIDADES).join(' | '),
        F46_DECLS: ensureArray(p.F46_DECLS).join(' | '),
        F46_CONDICOES: ensureArray(p.F46_CONDICOES).join(' | '),
        F46_JUST_PLANOS: p.F46_JUST_PLANOS, F46_COMP_CUMPR: p.F46_COMP_CUMPR
      },
      {sec:'F44 / F45 — listas e textos',
        F44_CRITERIOS: ensureArray(p.F44_CRITERIOS).join(' | '),
        F44_FINALIDADES: ensureArray(p.F44_FINALIDADES).join(' | '),
        F44_DECLS: ensureArray(p.F44_DECLS).join(' | '),
        F45_CONDICOES: ensureArray(p.F45_CONDICOES).join(' | '),
        JUSTIFICATIVAS_GERAIS: p.JUSTIFICATIVAS_GERAIS
      },
      {sec:'Marcas auxiliares',
        HAS_TERMO_ENC_GESCON: p.HAS_TERMO_ENC_GESCON, N_GESCON: p.N_GESCON, DATA_ENC_VIA_GESCON: p.DATA_ENC_VIA_GESCON,
        SEI_PROCESSO: p.SEI_PROCESSO
      },
      {sec:'Gerado em',
        DATA_SOLIC_GERADA: p.DATA_SOLIC_GERADA, HORA_SOLIC_GERADA: p.HORA_SOLIC_GERADA, ANO_SOLIC_GERADA: p.ANO_SOLIC_GERADA
      }
    ];

    console.group(title);
    console.table(resumo);
    console.groupEnd();
  }

  // ---------- veredito triplo ----------
  function verdictTriplo(formValues, payload, posted){
    const F = normalizeObjKeys(formValues||{});
    const P = normalizeObjKeys(payload||{});
    const S = normalizeObjKeys(posted||{});

    const fKeys = Object.keys(F);
    const p1 = Object.keys(P);
    const p2 = Object.keys(S);

    const miss_p1 = fKeys.filter(k=> !p1.includes(k));
    const miss_p2 = fKeys.filter(k=> !p2.includes(k));
    const empt_p1 = p1.filter(k=> isEmpty(P[k]));
    const empt_p2 = p2.filter(k=> isEmpty(S[k]));
    const diff_p1 = p1.filter(k=> JSON.stringify(P[k]) !== JSON.stringify(F[k]));
    const diff_p2 = p2.filter(k=> JSON.stringify(S[k]) !== JSON.stringify(F[k]));

    console.group('✅ VEREDITO — FORM × buildPayload() × ENVIADO (chaves canonizadas)');
    console.info('Faltando no buildPayload:', miss_p1.length, miss_p1);
    console.info('Faltando no ENVIADO   :', miss_p2.length, miss_p2);
    console.info('Vazios no buildPayload:', empt_p1.length, empt_p1);
    console.info('Vazios no ENVIADO     :', empt_p2.length, empt_p2);
    console.info('Diferentes FORM→build :', diff_p1.length, diff_p1);
    console.info('Diferentes FORM→ENVIADO:', diff_p2.length, diff_p2);
    console.groupEnd();

    // dumps amigáveis
    console.group('📦 FORM (canon)'); console.table(Object.entries(F).map(([k,v])=>({campo:k,valor:Array.isArray(v)?JSON.stringify(v):v}))); console.groupEnd();
    console.group('🚧 buildPayload() (canon)'); console.table(Object.entries(P).map(([k,v])=>({campo:k,valor:Array.isArray(v)?JSON.stringify(v):v}))); console.groupEnd();
    if (posted){
      console.group('🚀 ENVIADO (canon)'); console.table(Object.entries(S).map(([k,v])=>({campo:k,valor:Array.isArray(v)?JSON.stringify(v):v}))); console.groupEnd();
    }

    // resumo humano dos três
    humanSummary(F, '📋 RESUMO HUMANO — FORM (DOM)');
    humanSummary(P, '📋 RESUMO HUMANO — buildPayload()');
    if (posted) humanSummary(S, '📋 RESUMO HUMANO — ENVIADO');

    return {miss_p1, miss_p2, empt_p1, empt_p2, diff_p1, diff_p2};
  }

  // ---------- interceptadores (JSON, FormData, x-www-form-urlencoded) ----------
  let lastPosted = null;
  const originalFetch = window.fetch;
  function patchFetch(){
    if (!cfg.interceptarEnvio || window.__FETCH_PATCHED__) return;
    window.__FETCH_PATCHED__ = true;

    window.fetch = async function(input, init){
      let url = typeof input==='string' ? input : (input?.url || '');
      let method = (init?.method || (typeof input!=='string' ? input.method : '') || 'GET').toUpperCase();
      try{
        if (method==='POST' && init){
          const ctype = (init.headers && (init.headers['Content-Type']||init.headers['content-type'])) || '';
          const bodyRaw = init.body;

          let body = null;
          if (typeof bodyRaw==='string'){
            if (ctype.includes('application/json')){
              try{ body = JSON.parse(bodyRaw); }catch{ body = {__raw: bodyRaw}; }
            } else if (ctype.includes('application/x-www-form-urlencoded')){
              body = {};
              const usp = new URLSearchParams(bodyRaw);
              usp.forEach((v,k)=>{ const ck=canon(k); if (ck in body){ body[ck]=[].concat(body[ck],v); } else body[ck]=v; });
            } else {
              // pode ser string qualquer
              body = {__raw: bodyRaw};
            }
          } else if (bodyRaw instanceof FormData){
            body = {};
            for (const [k,v] of bodyRaw.entries()){
              const ck = canon(k);
              if (v instanceof File){
                const meta = {name:v.name, size:v.size, type:v.type};
                body[ck] = body[ck] ? [].concat(body[ck], meta) : meta;
              } else {
                body[ck] = body[ck] ? [].concat(body[ck], v) : v;
              }
            }
          } else if (bodyRaw){
            // tentativa de ler Request.body já serializado
            try{
              const asText = bodyRaw.toString();
              if (asText && asText.startsWith('{')) body = JSON.parse(asText);
            }catch{}
          }

          if (body){
            lastPosted = {url, method, body: normalizeObjKeys(body)};
            console.info('📡 [fetch] POST interceptado →', url, lastPosted.body);
            if (cfg.coagirNoEnvio){
              const {out} = coerceForApi(lastPosted.body);
              init.body = JSON.stringify(out);
              lastPosted = {url, method, body: out, coerced:true};
              console.info('♻️ [fetch] payload coercedido aplicado antes do envio.');
            }
          }
        }
      }catch(e){ console.warn('[fetch patch warn]', e); }
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
        if (_method==='POST' && body!=null){
          let parsed = null;
          if (typeof body==='string'){
            // tenta json depois urlencoded
            try{ parsed = JSON.parse(body); }
            catch{
              const usp = new URLSearchParams(body);
              parsed = {}; usp.forEach((v,k)=>{ const ck=canon(k); parsed[ck] = parsed[ck] ? [].concat(parsed[ck],v) : v; });
            }
          } else if (body instanceof FormData){
            parsed = {};
            for (const [k,v] of body.entries()){
              const ck = canon(k);
              if (v instanceof File){ parsed[ck] = parsed[ck] ? [].concat(parsed[ck], {name:v.name,size:v.size,type:v.type}) : {name:v.name,size:v.size,type:v.type}; }
              else { parsed[ck] = parsed[ck] ? [].concat(parsed[ck], v) : v; }
            }
          }
          if (parsed){
            lastPosted = {url:_url, method:_method, body: normalizeObjKeys(parsed)};
            console.info('📡 [xhr] POST interceptado →', _url, lastPosted.body);
            if (cfg.coagirNoEnvio){
              const {out} = coerceForApi(lastPosted.body);
              body = JSON.stringify(out);
              lastPosted = {url:_url, method:_method, body: out, coerced:true};
              console.info('♻️ [xhr] payload coercedido aplicado antes do envio.');
            }
          }
        }
      }catch(e){ console.warn('[xhr patch warn]', e); }
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
        <strong>Debugador SOLIC-CRP v2.2</strong>
        <span id="dbg-badge" style="margin-left:auto;background:#2a2;padding:2px 6px;border-radius:6px;">idle</span>
      </div>
      <div id="dbg-body" style="margin-top:8px; font-size:12px; opacity:.95">
        Pronto. Preencha normalmente — eu capturo tudo e mostro no console.
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
      const {formValues, meta} = snapshotFormDeep();

      let payload = {};
      if (typeof window.buildPayload==='function'){
        try { payload = await window.buildPayload(); }
        catch(e){ console.warn('[debug] buildPayload falhou; usando FORM como fallback.', e); payload = {...formValues}; }
      } else payload = {...formValues};

      const {out: coerced, notes} = coerceForApi(payload);
      if (notes.length){ console.group('♻️ Coerções para compatibilidade com a API'); console.table(notes); console.groupEnd(); }

      const posted = lastPosted?.body || null;

      const diff = verdictTriplo(formValues, payload, posted);

      const filled = Object.entries(formValues).filter(([k,v])=> !isEmpty(v)).length;
      const total = Object.keys(formValues).length;
      setBody(`
        <div><b>Origem:</b> ${origin}</div>
        <div><b>Campos (todas as etapas):</b> ${filled}/${total} preenchidos</div>
        <div><b>Miss build:</b> ${diff.miss_p1.length} | <b>Miss enviado:</b> ${diff.miss_p2.length}</div>
        <div><b>Vazios build:</b> ${diff.empt_p1.length} | <b>Vazios enviado:</b> ${diff.empt_p2.length}</div>
        <div><b>Dif FORM→build:</b> ${diff.diff_p1.length} | <b>Dif FORM→enviado:</b> ${diff.diff_p2.length}</div>
        <div style="margin-top:6px;opacity:.8">Conferir resumos “📋” no console.</div>
      `);
      setBadge('ok','#2a2');

      lastAudit = {formValues, payload, coerced, posted, diff, meta};
      return lastAudit;
    }catch(e){
      console.error('[debugador v2.2] falhou', e);
      setBadge('erro','#a22');
    }
  }

  function doDownloads(){
    if (!cfg.baixarArquivos || !lastAudit.formValues) return;
    const rows = [['categoria','campo','detalhe']];
    lastAudit.diff?.miss_p1?.forEach(k => rows.push(['miss_build',k,'não entrou no buildPayload']));
    lastAudit.diff?.miss_p2?.forEach(k => rows.push(['miss_enviado',k,'não entrou no ENVIADO']));
    lastAudit.diff?.empt_p1?.forEach(k => rows.push(['vazio_build',k,'']));
    lastAudit.diff?.empt_p2?.forEach(k => rows.push(['vazio_enviado',k,'']));
    lastAudit.diff?.diff_p1?.forEach(k => rows.push(['dif_form_build',k,'']));
    lastAudit.diff?.diff_p2?.forEach(k => rows.push(['dif_form_enviado',k,'']));
    download('debug_veredito.csv', toCSV(rows), 'text/csv');
    download('form_snapshot.json', JSON.stringify(normalizeObjKeys(lastAudit.formValues),null,2), 'application/json');
    download('payload_build.json', JSON.stringify(normalizeObjKeys(lastAudit.payload),null,2), 'application/json');
    download('payload_coercido.json', JSON.stringify(lastAudit.coerced,null,2), 'application/json');
    if (lastAudit.posted) download('payload_enviado.json', JSON.stringify(normalizeObjKeys(lastAudit.posted),null,2), 'application/json');
    download('form_meta_todas_etapas.json', JSON.stringify(lastAudit.meta,null,2), 'application/json');
  }

  // ---------- termo & data-k ----------
  async function openTermoAndCheck(){
    try{
      const audit = lastAudit.formValues ? lastAudit : await runAudit('open-termo');
      const payload = cfg.coagirNoEnvio ? audit.coerced : normalizeObjKeys(audit.payload);
      sessionStorage.setItem(cfg.storageKey, JSON.stringify(payload));

      const w = window.open(cfg.termoPath + '#debug', '_blank');
      if (!w){ alert('Pop-up bloqueado. Permita pop-ups.'); return; }

      const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
      for (let i=0;i<60;i++){ if (w.document && w.document.readyState==='complete') break; await sleep(100); }

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
</script>
