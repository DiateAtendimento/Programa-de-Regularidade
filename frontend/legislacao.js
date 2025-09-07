// One-page Legislação — efeitos leves, scroll suave, scrollspy e utilitários
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  /* ========= Reveal on Scroll ========= */
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });

  $$('.reveal').forEach(el => io.observe(el));

  /* ========= Smooth scroll com offset (sticky nav) ========= */
  function scrollToWithOffset(target) {
    const el = (typeof target === 'string') ? document.querySelector(target) : target;
    if (!el) return;

    // calcula offset aproximado (altura da toc-nav + algum respiro)
    const toc = $('#tocNav');
    const delta = (toc?.offsetHeight || 64) + 10;

    const y = el.getBoundingClientRect().top + window.scrollY - delta;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }

  // interceptar cliques nas âncoras do toc
  $$('#tocNav a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href');
      history.pushState(null, '', id);
      scrollToWithOffset(id);
    });
  });

  // links de âncora nos títulos (ícone de link)
  $$('.anchor-link').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const hash = btn.getAttribute('data-anchor');
      const url = location.origin + location.pathname + (hash || '');
      try {
        await navigator.clipboard.writeText(url);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      } catch {
        // fallback
      }
      if (hash) {
        history.pushState(null, '', hash);
        scrollToWithOffset(hash);
      }
    });
  });

  // se veio com hash, ajusta a posição com offset após carregar
  window.addEventListener('load', () => {
    if (location.hash) {
      setTimeout(() => scrollToWithOffset(location.hash), 50);
    }
  });

  /* ========= ScrollSpy (Bootstrap) ========= */
  try {
    // usa o body para monitorar o scroll
    new bootstrap.ScrollSpy(document.body, {
      target: '#tocNav',
      offset: 110
    });
  } catch (_) {}

  /* ========= Back to top ========= */
  const back = $('#backToTop');
  const onScroll = () => {
    const y = window.scrollY || document.documentElement.scrollTop;
    back?.classList.toggle('show', y > 600);
  };
  window.addEventListener('scroll', onScroll, { passive:true });
  back?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* ========= Botão “Copiar e-mail” ========= */
  $$('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const val = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(val);
        const old = btn.textContent;
        btn.textContent = 'Copiado!';
        setTimeout(() => (btn.textContent = old), 900);
      } catch {}
    });
  });
})();
