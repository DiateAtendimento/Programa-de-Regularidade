// binder.js — drop-in genérico
(() => {
  const getByPath = (obj, path) => {
    if (!path) return undefined;
    const arr = path.replace(/\[\]/g,'').split('.');
    let cur = obj;
    for (const k of arr) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  };

  const listAllPaths = (obj, base = '', out = []) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) {
        const p = base ? base + '.' + k : k;
        listAllPaths(obj[k], p, out);
      }
    } else if (Array.isArray(obj)) {
      out.push(base + '[]');
      obj.forEach((v,i)=>listAllPaths(v, base + `[${i}]`, out));
    } else {
      out.push(base);
    }
    return out;
  };

  function renderList(ul, values) {
    // Espera um template-filho com data-item (ex.: <li data-item></li>)
    const tpl = ul.querySelector('[data-item]');
    ul.innerHTML = '';
    (values || []).forEach(v => {
      const li = tpl ? tpl.cloneNode(true) : document.createElement('li');
      if (li.querySelector('[data-bind-item]')) {
        li.querySelectorAll('[data-bind-item]').forEach(n => {
          const k = n.getAttribute('data-bind-item');
          n.textContent = (v && v[k]) ?? '';
        });
      } else {
        li.textContent = String(v ?? '');
      }
      li.removeAttribute('data-item');
      ul.appendChild(li);
    });
  }

  function bindAll(root, data, {strict=false}={}) {
    const report = {
      missingData: [],          // [{path, selector}]
      missingSelectors: [],     // reservado para casos raros
      usedPaths: new Set(),     // paths que o template usou
      unusedDataPaths: []       // preenchido no final
    };

    // Fields simples
    root.querySelectorAll('[data-bind]').forEach(el => {
      const path = el.getAttribute('data-bind');
      const val = getByPath(data, path);
      report.usedPaths.add(path);
      if (val === undefined || val === null || val === '') {
        report.missingData.push({ path, selector: describe(el) });
        if (strict) mark(el);
        el.textContent = '';
      } else {
        el.textContent = String(val);
      }
    });

    // Listas (array)
    root.querySelectorAll('[data-list]').forEach(el => {
      const path = el.getAttribute('data-list');
      const val = getByPath(data, path);
      report.usedPaths.add(path.endsWith('[]') ? path : path + '[]');
      if (!Array.isArray(val) || val.length === 0) {
        report.missingData.push({ path, selector: describe(el) });
        if (strict) mark(el);
        el.innerHTML = '';
      } else {
        renderList(el, val);
      }
    });

    // Descobrir paths não usados (ajuda a pegar dado que nunca cai no HTML)
    const all = listAllPaths(data);
    report.unusedDataPaths = all.filter(p => !report.usedPaths.has(p) && !report.usedPaths.has(p.replace(/\[\d+\]/g,'[]')));

    // UI de diagnóstico (se ativado)
    if (new URL(location.href).searchParams.get('diag') === '1' || window.BINDER_DEBUG) {
      console.group('%cDIAGNÓSTICO (binder.js)', 'font-weight:bold');
      console.table(report.missingData);
      if (report.unusedDataPaths.length) {
        console.log('Paths de dados não usados no template:', report.unusedDataPaths);
      }
      console.groupEnd();
      showOverlay(report);
    }

    return report;
  }

  const describe = el => {
    const id = el.id ? '#'+el.id : '';
    const cls = el.className ? '.'+String(el.className).trim().replace(/\s+/g,'.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const mark = el => {
    el.style.outline = '2px dashed #d33';
    el.title = 'binder: valor ausente';
  };

  function showOverlay(rep) {
    const has = rep.missingData.length || rep.unusedDataPaths.length;
    if (!has) return;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;background:#111;color:#fff;padding:10px 12px;border-radius:10px;font:12px/1.4 system-ui;z-index:999999;max-width:360px';
    box.innerHTML = `<b>Binder – diagnóstico</b><br>
    Faltando dados: ${rep.missingData.length}<br>
    Dados não usados: ${rep.unusedDataPaths.length}
    <div style="margin-top:6px;opacity:.8">Abra o console para detalhes.</div>`;
    document.body.appendChild(box);
    setTimeout(()=>box.remove(), 8000);
  }

  // Exponha uma API simples
  window.Binder = { bindAll };
})();
