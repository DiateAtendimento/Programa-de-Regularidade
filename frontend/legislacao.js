// One-page Legislação — efeitos leves, scroll suave, scrollspy e utilitários
(() => {
  const $  = (s, r=document) => r.querySelector(s);
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
    btn.addEventListener('click', async () => {
      const hash = btn.getAttribute('data-anchor');
      const url = location.origin + location.pathname + (hash || '');
      try {
        await navigator.clipboard.writeText(url);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      } catch {
        // fallback silencioso
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

  /* ========= Baixar PDF (Google Drive → download direto) ========= */
  // Cole aqui o link de compartilhamento do Google Drive
  const SHARE_URL = "https://drive.google.com/file/d/1uDR5iMRGuHmNapNUkrxKxyKUCA5IlzcR/view?usp=drive_link";

  // Converte o link de "view" do Drive para a URL de download direto
  function driveDirectDownload(url) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
    const id = m ? m[1] : null;
    return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
  }

  const direct = driveDirectDownload(SHARE_URL);

  // Preferencialmente um elemento com id="btnBaixarPDF".
  // Se não houver, pega o primeiro .btn-hero dentro do .leg-hero.
  const btnPDF =
    $('#btnBaixarPDF') ||
    $('.leg-hero .btn-hero');

  if (btnPDF && direct) {
    btnPDF.setAttribute('href', direct);
    btnPDF.setAttribute('target', '_blank');   // abre em nova aba
    btnPDF.setAttribute('rel', 'noopener');    // segurança
    btnPDF.setAttribute('download', 'Programa-Regularidade.pdf'); // sugestão de nome

    // Fallback: se algum navegador bloquear o "download" cross-origin
    btnPDF.addEventListener('click', (e) => {
      // Se o href não estiver aplicável, força a abertura
      if (!btnPDF.href || btnPDF.href === '#') {
        e.preventDefault();
        window.open(direct, '_blank', 'noopener');
      }
    });
  }
})();
