'use strict';

const reduced = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
const touch   = () => window.matchMedia('(hover:none)').matches;

/* ── Cursor ── */
if (!touch()) {
  const dot = document.querySelector('.cursor');
  let mx=-100, my=-100, cx=-100, cy=-100;
  const lerp = (a,b,t) => a+(b-a)*t;
  (function tick() {
    cx = lerp(cx,mx,.15); cy = lerp(cy,my,.15);
    dot.style.left = cx+'px'; dot.style.top = cy+'px';
    requestAnimationFrame(tick);
  })();
  document.addEventListener('mousemove', e => { mx=e.clientX; my=e.clientY; });
  document.addEventListener('mouseleave', () => { mx=-200; my=-200; });
  document.querySelectorAll('a,button,.svc').forEach(el => {
    el.addEventListener('mouseenter', () => dot.classList.add('hov'));
    el.addEventListener('mouseleave', () => dot.classList.remove('hov'));
  });
  document.addEventListener('mousedown', () => dot.classList.add('press'));
  document.addEventListener('mouseup',   () => dot.classList.remove('press'));
}

/* ── Scroll Reveal ── */
const reveals = document.querySelectorAll('[data-reveal]');
if (reduced()) {
  reveals.forEach(el => el.classList.add('on'));
} else {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('on'); io.unobserve(e.target); } });
  }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
  reveals.forEach(el => io.observe(el));
}

/* ── Nav ── */
const nav = document.getElementById('nav');
const burger = nav.querySelector('.nav__burger');
const lightSections = ['tjanster','process','om'];

function updateNav() {
  const y = window.scrollY;
  let overLight = false;

  document.querySelectorAll('.intro, .svc, .process, .about').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.top <= 62 && r.bottom > 62) overLight = true;
  });

  if (overLight) {
    nav.classList.remove('nav--scrolled');
    nav.classList.add('nav--light');
  } else {
    nav.classList.remove('nav--light');
    if (y > 40) nav.classList.add('nav--scrolled');
    else nav.classList.remove('nav--scrolled');
  }
}
/* ── Active nav link ── */
function updateActiveLink() {
  const links = nav.querySelectorAll('.nav__links a:not(.nav__mobile-cta)');
  const sectionIds = ['tjanster', 'process', 'om', 'kontakt'];
  let activeId = null;

  sectionIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top <= 80 && r.bottom > 80) activeId = id;
  });

  links.forEach(a => {
    const matches = activeId !== null && a.getAttribute('href') === '#' + activeId;
    a.classList.toggle('active', matches);
  });
}

window.addEventListener('scroll', () => { updateNav(); updateActiveLink(); }, { passive: true });
updateNav();
updateActiveLink();

burger.addEventListener('click', () => {
  const open = nav.classList.toggle('nav--open');
  burger.setAttribute('aria-expanded', open);
  document.body.style.overflow = open ? 'hidden' : '';
});
nav.querySelectorAll('.nav__links a').forEach(a => {
  a.addEventListener('click', () => {
    nav.classList.remove('nav--open');
    burger.setAttribute('aria-expanded','false');
    document.body.style.overflow = '';
  });
});
document.addEventListener('keydown', e => {
  if (e.key==='Escape' && nav.classList.contains('nav--open')) {
    nav.classList.remove('nav--open');
    burger.setAttribute('aria-expanded','false');
    document.body.style.overflow = '';
  }
});
