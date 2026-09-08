/* IPTV Editor — editor da lista, roda inteiro no navegador.
 *
 * O catalogo do provedor fica no IndexedDB. As suas edicoes ficam num "overlay"
 * pequeno (so o que voce mudou), salvo no KV. Publicar significa gerar aqui os
 * arquivos que o player vai ler e enviar prontos para o Worker.
 */

const KINDS = ['live', 'vod', 'series'];
const LABEL = { live: 'Ao Vivo', vod: 'Filmes', series: 'Séries' };
const ROW_H = 34;
const UNCAT = '999999';          // pasta "Sem pasta"
const NEW_CAT_BASE = 900000;     // ids das pastas que voce cria
const CHUNK_BYTES = 4 * 1024 * 1024;

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };

/* ------------------------------------------------------------------ estado */

let token = localStorage.getItem('iptv_token') || '';
let info = null;                                  // dados do Worker (link, host)
let catalog = { live: [], vod: [], series: [] };  // catalogo bruto do provedor
let origCats = { live: [], vod: [], series: [] }; // categorias originais
let state = null;                                 // overlay (as suas edicoes)
let kind = 'live';
let curCat = 'all';
let view = [];                                    // indices visiveis no momento
let selected = new Set();
let lastClicked = -1;
let dirty = false;

/* ------------------------------------------------------------------ helpers */

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function modal(html, setup) {
  const m = $('#modal'), box = $('#modal-box');
  box.innerHTML = html;
  m.hidden = false;
  const close = () => { m.hidden = true; box.innerHTML = ''; };
  box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  m.onclick = (e) => { if (e.target === m) close(); };
  if (setup) setup(box, close);
  const first = box.querySelector('input, select');
  if (first) setTimeout(() => first.focus(), 30);
  return close;
}

const prog = {
  open(title) {
    $('#prog-title').textContent = title;
    $('#prog-msg').textContent = '';
    $('#prog-log').textContent = '';
    $('#prog-fill').style.width = '0%';
    $('#prog-close').hidden = true;
    $('#progress').hidden = false;
  },
  set(pct, msg) {
    $('#prog-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (msg) $('#prog-msg').textContent = msg;
  },
  log(line) {
    const l = $('#prog-log');
    l.textContent += line + '\n';
    l.scrollTop = l.scrollHeight;
  },
  done(msg) {
    $('#prog-fill').style.width = '100%';
    $('#prog-msg').textContent = msg;
    $('#prog-close').hidden = false;
  },
  close() { $('#progress').hidden = true; },
};
$('#prog-close').addEventListener('click', () => prog.close());

/* ---------------------------------------------------------------- API do Worker */

async function api(path, opts = {}) {
  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: { authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    duplex: opts.body ? 'half' : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Sessão expirada'); }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res;
}

const apiJson = (path, opts) => api(path, opts).then((r) => r.json());

/* -------------------------------------------------------------- IndexedDB */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('iptv-editor', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/* --------------------------------------------------------- modelo derivado */

const idOf = (k, it) => String(k === 'series' ? it.series_id : it.stream_id);

function newState() {
  return { v: 1, cats: { live: [], vod: [], series: [] }, items: { live: {}, vod: {}, series: {} }, opts: { m3uSeries: false } };
}

/** Na primeira vez, as pastas do provedor viram as suas pastas. */
function seedCats(k) {
  if (state.cats[k] && state.cats[k].length) return;
  state.cats[k] = origCats[k].map((c) => ({ id: String(c.category_id), name: c.category_name, hidden: false }));
}

const catsOf = (k) => state.cats[k] || [];
const catById = (k, id) => catsOf(k).find((c) => c.id === String(id));
const ov = (k, id) => state.items[k][id];

function effName(k, it) {
  const o = ov(k, idOf(k, it));
  return (o && o.n) || it.name || it.title || '';
}

function effCat(k, it) {
  const o = ov(k, idOf(k, it));
  if (o && o.c) return o.c;
  const orig = String(it.category_id ?? '');
  return catById(k, orig) ? orig : UNCAT;
}

function isHidden(k, it) {
  const o = ov(k, idOf(k, it));
  if (o && o.h) return true;
  const c = catById(k, effCat(k, it));
  return !!(c && c.hidden);
}

function patch(k, id, changes) {
  const cur = state.items[k][id] || {};
  const next = { ...cur, ...changes };
  for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
  if (Object.keys(next).length) state.items[k][id] = next;
  else delete state.items[k][id];
  dirty = true;
}

/** Pasta "Sem pasta" so aparece quando ha itens nela. */
function ensureUncat(k) {
  const has = catalog[k].some((it) => effCat(k, it) === UNCAT);
  const exists = catById(k, UNCAT);
  if (has && !exists) state.cats[k].push({ id: UNCAT, name: 'Sem pasta', hidden: false });
  if (!has && exists) state.cats[k] = state.cats[k].filter((c) => c.id !== UNCAT);
}

function counts(k) {
  const map = new Map();
  for (const it of catalog[k]) {
    const c = effCat(k, it);
    map.set(c, (map.get(c) || 0) + 1);
  }
  return map;
}

/* ------------------------------------------------------------------ render */

function renderTabs() {
  for (const k of KINDS) $('#c-' + k).textContent = catalog[k].length.toLocaleString('pt-BR');
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
}
const $$ = (s) => Array.from(document.querySelectorAll(s));

function renderCats() {
  ensureUncat(kind);
  const ul = $('#cat-list');
  const filter = $('#cat-search').value.trim().toLowerCase();
  const cnt = counts(kind);
  ul.innerHTML = '';

  const all = el('li', curCat === 'all' ? 'active' : '');
  all.append(el('span', 'grip', ' '), el('span', 'cname', 'Todos os itens'),
             el('span', 'cnum', catalog[kind].length.toLocaleString('pt-BR')));
  all.addEventListener('click', () => { curCat = 'all'; clearSel(); renderCats(); renderList(); });
  bindCatDrop(all, null);
  ul.append(all);

  catsOf(kind).forEach((c, i) => {
    if (filter && !c.name.toLowerCase().includes(filter)) return;
    const li = el('li', (curCat === c.id ? 'active ' : '') + (c.hidden ? 'hidden-cat' : ''));
    li.draggable = true;
    li.dataset.index = i;

    li.append(el('span', 'grip', '⠿'), el('span', 'cname', c.name),
              el('span', 'cnum', (cnt.get(c.id) || 0).toLocaleString('pt-BR')));

    const menu = el('button', 'row-menu', '⋯');
    menu.title = 'Opções da pasta';
    menu.addEventListener('click', (e) => { e.stopPropagation(); catMenu(c); });
    li.append(menu);

    li.addEventListener('click', () => { curCat = c.id; clearSel(); renderCats(); renderList(); });
    li.addEventListener('dblclick', () => renameCat(c));

    // reordenar pastas
    li.addEventListener('dragstart', (e) => {
      if (dragItems) return;
      e.dataTransfer.setData('text/cat', String(i));
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    bindCatDrop(li, c);
    ul.append(li);
  });

  const vis = catsOf(kind).filter((c) => !c.hidden).length;
  $('#side-foot').textContent = `${catsOf(kind).length} pastas · ${vis} visíveis`;
}

/** Uma pasta aceita tanto itens arrastados quanto outra pasta (reordenar). */
function bindCatDrop(node, cat) {
  node.addEventListener('dragover', (e) => {
    if (!dragItems && !e.dataTransfer.types.includes('text/cat')) return;
    if (dragItems && !cat) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop');

    if (dragItems && cat) { moveSelectedTo(cat.id); return; }

    const from = e.dataTransfer.getData('text/cat');
    if (from === '') return;
    const list = state.cats[kind];
    const item = list.splice(Number(from), 1)[0];
    const to = cat ? list.findIndex((c) => c.id === cat.id) : 0;
    list.splice(to < 0 ? list.length : to, 0, item);
    dirty = true;
    renderCats();
  });
}

function computeView() {
  const q = $('#item-search').value.trim().toLowerCase();
  const showHidden = $('#show-hidden').checked;
  view = [];
  const arr = catalog[kind];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (curCat !== 'all' && effCat(kind, it) !== curCat) continue;
    if (!showHidden && isHidden(kind, it)) continue;
    if (q && !effName(kind, it).toLowerCase().includes(q)) continue;
    view.push(i);
  }
}

function renderList() {
  computeView();
  $('#list-spacer').style.height = view.length * ROW_H + 'px';
  $('#list-empty').hidden = view.length > 0;
  if (!view.length) {
    $('#list-empty').textContent = catalog[kind].length
      ? 'Nenhum item aqui com os filtros atuais.'
      : 'Catálogo vazio. Clique em ↻ Sincronizar.';
  }
  drawRows();
  updateSelInfo();
}

/** Desenha apenas as linhas visiveis — a lista pode ter 27 mil itens. */
function drawRows() {
  const wrap = $('#list-wrap'), rows = $('#list-rows');
  const start = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - 6);
  const end = Math.min(view.length, start + Math.ceil(wrap.clientHeight / ROW_H) + 12);
  rows.style.transform = `translateY(${start * ROW_H}px)`;
  rows.innerHTML = '';

  for (let vi = start; vi < end; vi++) {
    const i = view[vi];
    const it = catalog[kind][i];
    const id = idOf(kind, it);
    const o = ov(kind, id);
    const hidden = isHidden(kind, it);

    const row = el('div', 'row' + (selected.has(id) ? ' sel' : '') + (hidden ? ' item-hidden' : ''));
    row.draggable = true;
    row.dataset.vi = vi;

    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(id);
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggle(id, vi, e); });
    row.append(cb);

    const name = el('span', 'rname', effName(kind, it));
    if (o && o.n) name.append(el('span', 'edited', '✎'));
    row.append(name);

    const c = catById(kind, effCat(kind, it));
    row.append(el('span', 'rcat', c ? c.name : '—'));

    row.addEventListener('click', (e) => toggle(id, vi, e));
    row.addEventListener('dblclick', () => renameOne(it));
    row.addEventListener('dragstart', (e) => {
      if (!selected.has(id)) { selected.clear(); selected.add(id); drawRows(); updateSelInfo(); }
      dragItems = true;
      e.dataTransfer.setData('text/items', '1');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { dragItems = false; });
    rows.append(row);
  }
}

let dragItems = false;
$('#list-wrap').addEventListener('scroll', () => drawRows(), { passive: true });

/* --------------------------------------------------------------- selecao */

function toggle(id, vi, e) {
  if (e.shiftKey && lastClicked >= 0) {
    const [a, b] = [Math.min(lastClicked, vi), Math.max(lastClicked, vi)];
    for (let x = a; x <= b; x++) selected.add(idOf(kind, catalog[kind][view[x]]));
  } else if (e.metaKey || e.ctrlKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
  } else {
    if (selected.size === 1 && selected.has(id)) selected.delete(id);
    else { selected.clear(); selected.add(id); }
  }
  lastClicked = vi;
  drawRows();
  updateSelInfo();
}

function clearSel() { selected.clear(); lastClicked = -1; updateSelInfo(); }

function updateSelInfo() {
  const n = selected.size;
  $('#sel-info').textContent = n
    ? `${n.toLocaleString('pt-BR')} selecionado${n > 1 ? 's' : ''} · ${view.length.toLocaleString('pt-BR')} exibidos`
    : `${view.length.toLocaleString('pt-BR')} itens exibidos`;
  $('#bulkbar').hidden = n === 0;
  $('#sel-all').checked = n > 0 && n === view.length;
}

function selectedItems() {
  const set = selected;
  return catalog[kind].filter((it) => set.has(idOf(kind, it)));
}

/* ---------------------------------------------------------------- acoes */

function moveSelectedTo(catId) {
  const items = selectedItems();
  for (const it of items) patch(kind, idOf(kind, it), { c: catId });
  toast(`${items.length} item(ns) movido(s) para "${catById(kind, catId).name}"`);
  clearSel();
  renderCats();
  renderList();
}

function pickFolder(title, onPick) {
  modal(
    `<h2>${title}</h2><input type="search" id="pf-q" placeholder="Filtrar pastas…">
     <div class="pick-list" id="pf-list" style="margin-top:10px"></div>
     <div class="modal-actions"><button data-close class="ghost">Cancelar</button></div>`,
    (box, close) => {
      const list = box.querySelector('#pf-list');
      const draw = () => {
        const q = box.querySelector('#pf-q').value.trim().toLowerCase();
        list.innerHTML = '';
        for (const c of catsOf(kind)) {
          if (q && !c.name.toLowerCase().includes(q)) continue;
          const d = el('div', '', c.name);
          d.addEventListener('click', () => { close(); onPick(c.id); });
          list.append(d);
        }
      };
      box.querySelector('#pf-q').addEventListener('input', draw);
      draw();
    }
  );
}

function renameOne(it) {
  const id = idOf(kind, it);
  modal(
    `<h2>Renomear</h2><label>Nome</label>
     <input type="text" id="rn" value="${escapeHtml(effName(kind, it))}">
     <div class="modal-actions">
       <button data-close class="ghost">Cancelar</button>
       <button id="rn-reset" class="ghost">Restaurar original</button>
       <button id="rn-ok" class="primary">Salvar</button>
     </div>`,
    (box, close) => {
      const input = box.querySelector('#rn');
      const save = () => { patch(kind, id, { n: input.value.trim() || null }); close(); renderList(); };
      box.querySelector('#rn-ok').addEventListener('click', save);
      box.querySelector('#rn-reset').addEventListener('click', () => { patch(kind, id, { n: null }); close(); renderList(); });
      onEnter(input, save);
    }
  );
}

function bulkRename() {
  const items = selectedItems();
  modal(
    `<h2>Renomear ${items.length} item(ns)</h2>
     <label>Localizar (deixe vazio para não substituir)</label><input type="text" id="br-find">
     <label>Substituir por</label><input type="text" id="br-repl">
     <label>Adicionar antes / depois</label>
     <div class="field-row"><input type="text" id="br-pre" placeholder="prefixo"><input type="text" id="br-suf" placeholder="sufixo"></div>
     <label class="chk" style="margin-top:12px"><input type="checkbox" id="br-re"> Localizar é uma expressão regular</label>
     <p class="muted" id="br-prev" style="font-size:12px;margin-top:12px"></p>
     <div class="modal-actions">
       <button data-close class="ghost">Cancelar</button>
       <button id="br-ok" class="primary">Aplicar</button>
     </div>`,
    (box, close) => {
      const get = (s) => box.querySelector(s);
      const build = (name) => {
        const f = get('#br-find').value, r = get('#br-repl').value;
        let out = name;
        if (f) {
          try {
            out = get('#br-re').checked ? out.replace(new RegExp(f, 'g'), r) : out.split(f).join(r);
          } catch { /* regex invalida: mantem o nome */ }
        }
        return (get('#br-pre').value + out + get('#br-suf').value).trim();
      };
      const preview = () => {
        const sample = items.slice(0, 2).map((it) => `${effName(kind, it)}  →  ${build(effName(kind, it))}`);
        get('#br-prev').textContent = 'Prévia: ' + (sample.join('   |   ') || '—');
      };
      box.querySelectorAll('input').forEach((i) => i.addEventListener('input', preview));
      preview();
      get('#br-ok').addEventListener('click', () => {
        let n = 0;
        for (const it of items) {
          const nn = build(effName(kind, it));
          if (nn && nn !== effName(kind, it)) { patch(kind, idOf(kind, it), { n: nn }); n++; }
        }
        close(); renderList(); toast(`${n} nome(s) alterado(s)`);
      });
    }
  );
}

function catMenu(c) {
  modal(
    `<h2>${escapeHtml(c.name)}</h2>
     <div class="pick-list">
       <div data-a="rename">✏️ Renomear pasta</div>
       <div data-a="toggle">${c.hidden ? '👁 Mostrar' : '🚫 Ocultar'} pasta na lista publicada</div>
       <div data-a="selectall">☑️ Selecionar todos os itens desta pasta</div>
       <div data-a="empty">📤 Mover todos os itens para outra pasta</div>
       <div data-a="delete" style="color:var(--danger)">🗑 Excluir pasta (itens vão para "Sem pasta")</div>
     </div>
     <div class="modal-actions"><button data-close class="ghost">Fechar</button></div>`,
    (box, close) => {
      box.querySelectorAll('[data-a]').forEach((d) =>
        d.addEventListener('click', () => {
          const a = d.dataset.a;
          close();
          if (a === 'rename') renameCat(c);
          if (a === 'toggle') { c.hidden = !c.hidden; dirty = true; renderCats(); renderList(); }
          if (a === 'selectall') {
            selected.clear();
            for (const it of catalog[kind]) if (effCat(kind, it) === c.id) selected.add(idOf(kind, it));
            curCat = c.id; renderCats(); renderList();
          }
          if (a === 'empty') {
            pickFolder('Mover todos para…', (target) => {
              let n = 0;
              for (const it of catalog[kind]) if (effCat(kind, it) === c.id) { patch(kind, idOf(kind, it), { c: target }); n++; }
              renderCats(); renderList(); toast(`${n} item(ns) movido(s)`);
            });
          }
          if (a === 'delete') {
            for (const it of catalog[kind]) if (effCat(kind, it) === c.id) patch(kind, idOf(kind, it), { c: UNCAT });
            state.cats[kind] = state.cats[kind].filter((x) => x.id !== c.id);
            dirty = true;
            if (curCat === c.id) curCat = 'all';
            renderCats(); renderList(); toast('Pasta excluída');
          }
        })
      );
    }
  );
}

function renameCat(c) {
  modal(
    `<h2>Renomear pasta</h2><label>Nome</label><input type="text" id="cn" value="${escapeHtml(c.name)}">
     <div class="modal-actions"><button data-close class="ghost">Cancelar</button><button id="cn-ok" class="primary">Salvar</button></div>`,
    (box, close) => {
      const input = box.querySelector('#cn');
      const save = () => { const v = input.value.trim(); if (v) { c.name = v; dirty = true; } close(); renderCats(); renderList(); };
      box.querySelector('#cn-ok').addEventListener('click', save);
      onEnter(input, save);
    }
  );
}

function newCat() {
  modal(
    `<h2>Nova pasta</h2><label>Nome</label><input type="text" id="nc" placeholder="Ex.: Meus Favoritos">
     <div class="modal-actions"><button data-close class="ghost">Cancelar</button><button id="nc-ok" class="primary">Criar</button></div>`,
    (box, close) => {
      const input = box.querySelector('#nc');
      const save = () => {
        const v = input.value.trim();
        if (!v) return;
        const used = catsOf(kind).map((c) => Number(c.id)).filter((n) => n >= NEW_CAT_BASE && n < Number(UNCAT));
        const id = String(Math.max(NEW_CAT_BASE, ...used) + 1);
        state.cats[kind].unshift({ id, name: v, hidden: false });
        dirty = true;
        close(); renderCats();
      };
      box.querySelector('#nc-ok').addEventListener('click', save);
      onEnter(input, save);
    }
  );
}

/** Enter confirma o campo. Alguns teclados/automacoes mandam 'Return'. */
function onEnter(input, fn) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Return' || e.keyCode === 13) { e.preventDefault(); fn(); }
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------ sincronizar */

const UPSTREAM = {
  live: { cats: 'get_live_categories', items: 'get_live_streams' },
  vod: { cats: 'get_vod_categories', items: 'get_vod_streams' },
  series: { cats: 'get_series_categories', items: 'get_series' },
};

async function sync() {
  prog.open('Sincronizando com o provedor');
  try {
    let step = 0;
    for (const k of KINDS) {
      prog.set((step / 6) * 100, `Baixando pastas de ${LABEL[k]}…`);
      origCats[k] = await apiJson(`/upstream?action=${UPSTREAM[k].cats}`);
      step++;
      prog.set((step / 6) * 100, `Baixando itens de ${LABEL[k]}…`);
      catalog[k] = await apiJson(`/upstream?action=${UPSTREAM[k].items}`);
      step++;
      prog.log(`${LABEL[k]}: ${catalog[k].length.toLocaleString('pt-BR')} itens em ${origCats[k].length} pastas`);
    }

    await idbSet('catalog', catalog);
    await idbSet('origCats', origCats);
    await idbSet('syncedAt', Date.now());

    for (const k of KINDS) seedCats(k);
    dirty = true;

    prog.done('Catálogo atualizado. Agora edite e clique em Publicar.');
    renderTabs(); renderCats(); renderList(); showSync(Date.now());
  } catch (e) {
    prog.log('ERRO: ' + e.message);
    prog.done('Falhou. Veja o erro acima.');
  }
}

function showSync(ts) {
  $('#sync-info').textContent = ts ? 'Sincronizado ' + new Date(ts).toLocaleString('pt-BR') : 'Nunca sincronizado';
}

/* --------------------------------------------------------------- publicar */

/** Monta a lista final de um tipo, ja com nomes e pastas que voce definiu. */
function buildPublished(k) {
  const visibleCats = catsOf(k).filter((c) => !c.hidden);
  const catIds = new Set(visibleCats.map((c) => c.id));
  const cats = visibleCats.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));

  const byCat = new Map(visibleCats.map((c) => [c.id, []]));
  const all = [];
  const names = {};
  let num = 1;

  for (const it of catalog[k]) {
    const id = idOf(k, it);
    const o = ov(k, id);
    if (o && o.h) continue;
    const cat = effCat(k, it);
    if (!catIds.has(cat)) continue;

    const name = effName(k, it);
    if (o && o.n) names[id] = name;

    const out = { ...it, num: num++, name, category_id: cat, category_ids: [Number(cat)] };
    if (k !== 'series') out.direct_source = '';
    if ('title' in out) out.title = name;
    all.push(out);
    byCat.get(cat).push(out);
  }
  return { cats, all, byCat, names };
}

function m3uLine(base, pu, pp, k, it, groupName) {
  const id = k === 'series' ? it.series_id : it.stream_id;
  const logo = it.stream_icon || it.cover || '';
  const tvg = it.epg_channel_id || '';
  const url = k === 'live'
    ? `${base}/live/${pu}/${pp}/${id}.ts`
    : `${base}/movie/${pu}/${pp}/${id}.${it.container_extension || 'mp4'}`;
  return `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${it.name}" tvg-logo="${logo}" group-title="${groupName}",${it.name}\n${url}\n`;
}

/** Envia os pedacos do M3U conforme eles enchem, para nao guardar 100 MB na memoria. */
function chunkWriter(onChunk) {
  let buf = '', size = 0, index = 0;
  return {
    async add(text) {
      buf += text;
      size += text.length;
      if (size >= CHUNK_BYTES) { await this.flush(); }
    },
    async flush() {
      if (!buf) return;
      await onChunk(index++, buf);
      buf = ''; size = 0;
    },
    get count() { return index; },
  };
}

const EP_RE = /^(.*?)[\s\-–]*S(\d{1,3})\s?E(\d{1,4})\b/i;

async function publish() {
  const includeSeries = state.opts.m3uSeries;
  prog.open('Publicando a sua lista');
  try {
    const base = info.base, pu = encodeURIComponent(info.playlistUser), pp = encodeURIComponent(info.playlistPass);

    prog.set(2, 'Limpando a publicação anterior…');
    for (const p of ['cat:', 'st:', 'm3u:', 'names:']) {
      await api(`/pub?prefix=${encodeURIComponent(p)}`, { method: 'DELETE' });
    }

    const built = {};
    let pct = 6;
    for (const k of KINDS) {
      prog.set(pct, `Preparando ${LABEL[k]}…`);
      const b = buildPublished(k);
      built[k] = b;

      await putBlob(`cat:${k}`, JSON.stringify(b.cats));
      await putBlob(`st:${k}`, JSON.stringify(b.all));
      for (const [cid, list] of b.byCat) await putBlob(`st:${k}:${cid}`, JSON.stringify(list));
      if (Object.keys(b.names).length) await putBlob(`names:${k}`, JSON.stringify(b.names));

      prog.log(`${LABEL[k]}: ${b.all.length.toLocaleString('pt-BR')} itens em ${b.cats.length} pastas`);
      pct += 12;
    }

    // ---- M3U -------------------------------------------------------------
    prog.set(46, 'Gerando o arquivo M3U…');
    const writer = chunkWriter((i, body) => putBlob(`m3u:${i}`, body));
    await writer.add('#EXTM3U\n');

    if (!includeSeries) {
      for (const k of ['live', 'vod']) {
        const catName = new Map(built[k].cats.map((c) => [c.category_id, c.category_name]));
        for (const it of built[k].all) await writer.add(m3uLine(base, pu, pp, k, it, catName.get(it.category_id) || ''));
      }
      await writer.flush();
      prog.log(`M3U: ao vivo + filmes (sem episódios de série)`);
    } else {
      await buildFullM3u(built, writer, base, pu, pp);
    }

    const meta = {
      generatedAt: new Date().toISOString(),
      m3uChunks: writer.count,
      counts: Object.fromEntries(KINDS.map((k) => [k, built[k].all.length])),
      m3uSeries: includeSeries,
    };
    await putBlob('meta', JSON.stringify(meta));

    prog.set(96, 'Salvando as suas edições…');
    await saveState();

    prog.done('Publicado. O link já está atualizado no seu player.');
    prog.log('Dica: no player, force um "atualizar lista" para ver as mudanças.');
    info.meta = meta;
  } catch (e) {
    prog.log('ERRO: ' + e.message);
    prog.done('Falhou. Veja o erro acima.');
  }
}

const putBlob = (key, body) => api(`/pub?key=${encodeURIComponent(key)}`, { method: 'PUT', body });

/**
 * M3U completo: le o M3U do provedor em streaming e reescreve cada entrada.
 * Os episodios de serie sao reagrupados pela pasta que voce deu a serie,
 * casando o nome "Serie S01E01" com o nome da serie.
 */
async function buildFullM3u(built, writer, base, pu, pp) {
  prog.set(50, 'Baixando o M3U do provedor (pode levar alguns minutos)…');

  // indices para decidir o que fazer com cada linha
  const liveById = new Map(built.live.all.map((x) => [String(x.stream_id), x]));
  const vodById = new Map(built.vod.all.map((x) => [String(x.stream_id), x]));
  const liveCat = new Map(built.live.cats.map((c) => [c.category_id, c.category_name]));
  const vodCat = new Map(built.vod.cats.map((c) => [c.category_id, c.category_name]));
  const serCat = new Map(built.series.cats.map((c) => [c.category_id, c.category_name]));

  // nome original da serie -> serie publicada
  const serByName = new Map();
  for (const s of catalog.series) {
    const key = String(s.name || '').trim().toLowerCase();
    if (key && !serByName.has(key)) serByName.set(key, String(s.series_id));
  }
  const pubSeries = new Map(built.series.all.map((x) => [String(x.series_id), x]));

  const res = await api('/upstream-m3u');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

  let rest = '', extinf = null, bytes = 0, lastPaint = 0;
  let kept = 0, skipped = 0, eps = 0, unmatched = 0;

  const handle = async (line) => {
    if (line.startsWith('#EXTINF')) { extinf = line; return; }
    if (!line || line.startsWith('#') || !extinf) return;

    const ex = extinf; extinf = null;
    const xid = (ex.match(/xui-id="(\d+)"/) || [])[1];
    const path = (line.match(/^https?:\/\/[^/]+(\/.*)$/) || [])[1];
    if (!path) return;
    const url = base + path;

    // canal ao vivo ou filme: usamos o que voce editou
    if (xid && liveById.has(xid)) {
      const it = liveById.get(xid);
      await writer.add(rewrite(ex, it.name, liveCat.get(it.category_id) || '') + url + '\n');
      kept++; return;
    }
    if (xid && vodById.has(xid)) {
      const it = vodById.get(xid);
      await writer.add(rewrite(ex, it.name, vodCat.get(it.category_id) || '') + url + '\n');
      kept++; return;
    }

    // episodio de serie: herda nome e pasta da serie
    const tvgName = (ex.match(/tvg-name="([^"]*)"/) || [])[1] || (ex.split(',').pop() || '');
    const m = EP_RE.exec(tvgName);
    if (!m) { unmatched++; return; }
    const sid = serByName.get(m[1].trim().toLowerCase());
    const s = sid && pubSeries.get(sid);
    if (!s) { skipped++; return; }  // serie oculta ou pasta oculta

    const epName = tvgName.replace(m[1].trim(), s.name).trim();
    await writer.add(rewrite(ex, epName, serCat.get(s.category_id) || '') + url + '\n');
    eps++;
  };

  const rewrite = (ex, name, group) => {
    let out = ex.replace(/tvg-name="[^"]*"/, `tvg-name="${name}"`)
                .replace(/group-title="[^"]*"/, `group-title="${group}"`);
    // o titulo exibido vem depois da ultima aspa dos atributos
    const q = out.lastIndexOf('"');
    const comma = out.indexOf(',', q < 0 ? 0 : q);
    if (comma >= 0) out = out.slice(0, comma + 1) + name;
    return out + '\n';
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    rest += value;
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const l of lines) await handle(l.trim());
    const now = Date.now();
    if (now - lastPaint > 400) {
      lastPaint = now;
      prog.set(50 + Math.min(44, (bytes / 120e6) * 44), `Processando M3U… ${(bytes / 1048576).toFixed(0)} MB`);
      await new Promise((r) => setTimeout(r, 0));  // deixa a tela respirar
    }
  }
  if (rest.trim()) await handle(rest.trim());
  await writer.flush();

  prog.log(`M3U completo: ${kept.toLocaleString('pt-BR')} canais/filmes + ${eps.toLocaleString('pt-BR')} episódios`);
  if (skipped) prog.log(`${skipped.toLocaleString('pt-BR')} episódios pulados (série ou pasta oculta)`);
  if (unmatched) prog.log(`${unmatched.toLocaleString('pt-BR')} entradas sem padrão SxxExx foram ignoradas`);
}

/* ------------------------------------------------------------------ link */

function showLink() {
  const b = info.base, u = encodeURIComponent(info.playlistUser), p = encodeURIComponent(info.playlistPass);
  const m3u = `${b}/get.php?username=${u}&password=${p}&type=m3u_plus&output=mpegts`;
  const meta = info.meta;
  modal(
    `<h2>🔗 O seu link</h2>
     <label>Modo Xtream (recomendado — séries com temporadas)</label>
     <div class="link-box">Servidor: ${b}<br>Usuário: ${escapeHtml(info.playlistUser)}<br>Senha: ${escapeHtml(info.playlistPass)}</div>
     <label>Modo M3U (lista única)</label>
     <div class="link-box">${escapeHtml(m3u)}</div>
     <label>EPG / Guia de programação</label>
     <div class="link-box">${b}/xmltv.php?username=${u}&amp;password=${p}</div>
     <label class="chk" style="margin-top:16px">
       <input type="checkbox" id="opt-series" ${state.opts.m3uSeries ? 'checked' : ''}>
       Incluir episódios de série no M3U
     </label>
     <p class="muted" style="font-size:12px;margin-top:6px">
       Deixe desligado se você usa o modo Xtream. Ligado, a publicação processa mais de 100 MB
       e demora vários minutos — só vale a pena se o seu player não suporta Xtream.
     </p>
     <p class="muted" style="font-size:12px;margin-top:14px">
       ${meta ? `Última publicação: ${new Date(meta.generatedAt).toLocaleString('pt-BR')} · ` +
         KINDS.map((k) => `${LABEL[k]}: ${meta.counts[k].toLocaleString('pt-BR')}`).join(' · ')
         : '<strong>Você ainda não publicou.</strong> Clique em Publicar para o link começar a funcionar.'}
     </p>
     <div class="modal-actions">
       <button id="copy-m3u" class="ghost">Copiar link M3U</button>
       <button data-close class="primary">Fechar</button>
     </div>`,
    (box) => {
      box.querySelector('#copy-m3u').addEventListener('click', () => {
        navigator.clipboard.writeText(m3u).then(() => toast('Link copiado'));
      });
      box.querySelector('#opt-series').addEventListener('change', (e) => {
        state.opts.m3uSeries = e.target.checked;
        dirty = true;
      });
    }
  );
}

/* ----------------------------------------------------------- estado remoto */

async function saveState() {
  await api('/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
  dirty = false;
}

async function loadAll() {
  info = await apiJson('/info');

  const saved = await apiJson('/state').catch(() => null);
  state = saved && saved.cats ? saved : newState();
  if (!state.items) state.items = { live: {}, vod: {}, series: {} };
  if (!state.opts) state.opts = { m3uSeries: false };
  for (const k of KINDS) { state.cats[k] ||= []; state.items[k] ||= {}; }

  const cached = await idbGet('catalog');
  if (cached) {
    catalog = cached;
    origCats = (await idbGet('origCats')) || origCats;
    showSync(await idbGet('syncedAt'));
  } else {
    showSync(null);
  }
  for (const k of KINDS) seedCats(k);

  renderTabs(); renderCats(); renderList();
  if (!cached) toast('Clique em ↻ Sincronizar para baixar a sua lista', 5000);
}

/* ---------------------------------------------------------------- eventos */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#login-pass').value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Falha no login');
    token = data.token;
    localStorage.setItem('iptv_token', token);
    start();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

function logout() {
  localStorage.removeItem('iptv_token');
  token = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
}

async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  try {
    await loadAll();
  } catch (e) {
    toast('Erro ao carregar: ' + e.message, 5000);
  }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  kind = b.dataset.kind;
  curCat = 'all';
  clearSel();
  seedCats(kind);
  renderTabs(); renderCats(); renderList();
});

$('#btn-sync').addEventListener('click', () => {
  if (catalog.live.length && !confirm('Rebaixar o catálogo do provedor? As suas edições são mantidas.')) return;
  sync();
});
$('#btn-publish').addEventListener('click', publish);
$('#btn-link').addEventListener('click', showLink);
$('#btn-new-cat').addEventListener('click', newCat);
$('#cat-search').addEventListener('input', renderCats);
$('#item-search').addEventListener('input', () => { renderList(); });
$('#show-hidden').addEventListener('change', renderList);

$('#sel-all').addEventListener('change', (e) => {
  selected.clear();
  if (e.target.checked) for (const i of view) selected.add(idOf(kind, catalog[kind][i]));
  drawRows(); updateSelInfo();
});

$('#bulkbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'move') pickFolder(`Mover ${selected.size} item(ns) para…`, moveSelectedTo);
  if (act === 'rename') bulkRename();
  if (act === 'hide' || act === 'show') {
    for (const it of selectedItems()) patch(kind, idOf(kind, it), { h: act === 'hide' ? 1 : null });
    toast(`${selected.size} item(ns) ${act === 'hide' ? 'ocultado(s)' : 'exibido(s)'}`);
    renderCats(); renderList();
  }
  if (act === 'reset') {
    for (const it of selectedItems()) state.items[kind][idOf(kind, it)] &&
      patch(kind, idOf(kind, it), { n: null, c: null, h: null });
    dirty = true;
    renderCats(); renderList(); toast('Itens restaurados ao original');
  }
  if (act === 'none') { clearSel(); drawRows(); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    e.preventDefault();
    for (const i of view) selected.add(idOf(kind, catalog[kind][i]));
    drawRows(); updateSelInfo();
  }
  if (e.key === 'Escape') { clearSel(); drawRows(); }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// salva as edicoes de tempos em tempos, para nao perder trabalho
setInterval(() => { if (dirty && token && state) saveState().catch(() => {}); }, 30000);

if (token) start();
