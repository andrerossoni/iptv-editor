/* Pequenos ajudantes usados por todas as telas. */

const $ = (sel, root = document) => root.querySelector(sel);

/** Cria um elemento: h('div', { class: 'x', onclick: fn }, 'texto', outroElemento). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Texto sem acento e em minusculas, para busca e comparacao de titulos. */
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Titulo para cruzar com o TMDB: sem "(2024)", "[LEG]", "4K" e afins. */
const cleanTitle = (s) =>
  norm(String(s || '').replace(/\[[^\]]*\]|\((?:19|20)\d\d\)|\b4k\b|\b(?:legendad[oa]|dublad[oa]|leg|dub)\b/gi, ' '));

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '';
  const hh = Math.floor(sec / 3600);
  const mm = Math.round((sec % 3600) / 60);
  return hh ? `${hh}h ${mm}min` : `${mm}min`;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

function shuffle(list, seed) {
  // Embaralha de forma estavel no dia: a tela inicial nao muda a cada clique.
  let s = seed || 1;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const daySeed = () => Math.floor(Date.now() / 86400000);

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const svg = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" ${extra}>${d}</svg>`;

const ICON = {
  play: svg('<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  back10: svg('<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="system-ui" font-weight="700">10</text>'),
  fwd30: svg('<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="system-ui" font-weight="700">30</text>'),
  plus: svg('<path d="M11 5h2v14h-2z"/><path d="M5 11h14v2H5z"/>'),
  check: svg('<path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/>'),
  info: svg('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>'),
  search: svg('<path d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.39-1.42 1.42-5.39-5.39A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>'),
  gear: svg('<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/>'),
  left: svg('<path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/>'),
  right: svg('<path d="M8.6 4.6 10 3.2l8.8 8.8L10 20.8l-1.4-1.4L16 12z"/>'),
  close: svg('<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/>'),
  next: svg('<path d="M5 5.5v13a1 1 0 0 0 1.5.86L16 13.5V18h2V6h-2v4.5L6.5 4.64A1 1 0 0 0 5 5.5z"/>'),
  list: svg('<path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z"/>'),
  volume: svg('<path d="M4 9v6h4l5 4V5L8 9zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9zm16.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z"/>'),
  expand: svg('<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>'),
  star: svg('<path d="m12 17.3 6.2 3.7-1.6-7 5.4-4.7-7.2-.6L12 2 9.2 8.7 2 9.3l5.4 4.7-1.6 7z"/>'),
  film: svg('<path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v2h2V5zm12 0v2h2V5zM5 9v2h2V9zm12 0v2h2V9zM5 13v2h2v-2zm12 0v2h2v-2zM5 17v2h2v-2zm12 0v2h2v-2zM9 5v14h6V5z"/>'),
  tv: svg('<path d="M3 6h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm1 2v9h16V8zm4-6 4 3.5L16 2l1.3 1.5L14.5 6h-5L6.7 3.5z"/>'),
};

const icon = (name) => h('span', { class: 'ico', html: ICON[name] });

/** Troca o conteudo de um elemento, ignorando filhos nulos (replaceChildren escreveria "null"). */
const fill = (el, ...children) => {
  el.replaceChildren();
  return append(el, children);
};
