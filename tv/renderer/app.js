/**
 * Telas do app. Navegacao em pilha: cada tela e redesenhada do zero ao entrar,
 * e "voltar" restaura a rolagem de onde voce estava.
 */

const ROW_LIMIT = 40;

/* As fileiras so desenham os cards quando chegam perto da tela. */
const rowObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      rowObserver.unobserve(e.target);
      e.target._fill?.();
    }
  },
  { rootMargin: '900px 0px' }
);

/* ------------------------------------------------------------ componentes */

function posterImg(src, name) {
  const fallback = () => h('div', { class: 'card-fallback' }, name);
  if (!src) return fallback();
  return h('img', {
    src,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    onerror: (e) => e.target.replaceWith(fallback()),
  });
}

function card(item, opts = {}) {
  const live = item.kind === 'live';
  const pct = opts.pct ?? (item.kind === 'movie' ? Watch.pct(item.key) : 0);
  const meta = opts.sub ?? [item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : ''].filter(Boolean).join('  ·  ');
  return h(
    'button',
    {
      class: `card ${live ? 'card-live' : 'card-poster'}`,
      'data-key': item.key,
      onclick: () => (opts.onClick ? opts.onClick() : App.openItem(item, opts.siblings)),
    },
    h(
      'div',
      { class: 'card-img' },
      posterImg(item.poster, item.name),
      opts.rank ? h('div', { class: 'card-rank' }, opts.rank) : null,
      !live && Providers.logo(item.prov) ? h('img', { class: 'card-prov', src: Providers.logo(item.prov), alt: Providers.name(item.prov), title: Providers.name(item.prov) }) : null,
      pct > 0.02 && pct < 0.97 ? h('div', { class: 'card-progress' }, h('i', { style: { width: `${pct * 100}%` } })) : null,
      Watch.inList(item.key) ? h('div', { class: 'card-badge' }, icon('check')) : null
    ),
    h('div', { class: 'card-cap' }, h('div', { class: 'card-name' }, item.name), meta ? h('div', { class: 'card-meta' }, meta) : null)
  );
}

/**
 * Fileira horizontal com setas grandes. `items` pode ser lista de itens ou de
 * { item, ...opcoesDoCard }.
 */
function row(title, items, opts = {}) {
  const entries = items.map((x) => (x.item ? x : { item: x }));
  const track = h('div', { class: 'track' });
  const left = h('button', { class: 'arrow arrow-l', 'aria-label': 'Anterior', onclick: () => slide(-1) }, icon('left'));
  const right = h('button', { class: 'arrow arrow-r', 'aria-label': 'Próximo', onclick: () => slide(1) }, icon('right'));
  const more = entries.length > ROW_LIMIT && !opts.noMore ? () => App.go('grid', { title, items: entries.map((e) => e.item) }) : null;

  const slide = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  const syncArrows = () => {
    left.classList.toggle('off', track.scrollLeft < 10);
    right.classList.toggle('off', track.scrollLeft + track.clientWidth >= track.scrollWidth - 10);
  };
  track.addEventListener('scroll', syncArrows, { passive: true });

  const sec = h(
    'section',
    { class: `row${opts.wide || entries[0]?.item.kind === 'live' ? ' row-wide' : ''}` },
    h(
      'h2',
      { class: `row-title${more ? ' link' : ''}`, onclick: more },
      title,
      opts.count ? h('span', { class: 'row-count' }, entries.length) : null,
      more ? h('span', { class: 'row-more' }, 'Ver tudo', icon('right')) : null
    ),
    h('div', { class: 'row-wrap' }, left, track, right)
  );

  sec._fill = () => {
    const shown = entries.slice(0, ROW_LIMIT);
    const siblings = opts.siblings || entries.map((e) => e.item);
    append(
      track,
      shown.map((e) => card(e.item, { siblings, ...e, item: undefined })),
      more ? h('button', { class: 'card card-more', onclick: more }, h('div', { class: 'card-img' }, h('span', {}, 'Ver todos', h('b', {}, entries.length)))) : null
    );
    requestAnimationFrame(syncArrows);
  };
  rowObserver.observe(sec);
  return sec;
}

function chips(options, current, onPick) {
  return h(
    'div',
    { class: 'chips' },
    options.map(([value, label]) => h('button', { class: `chip${value === current ? ' on' : ''}`, onclick: () => onPick(value) }, label))
  );
}

function button(label, iconName, onClick, cls = '') {
  return h('button', { class: `btn ${cls}`, onclick: onClick }, iconName ? icon(iconName) : null, h('span', {}, label));
}

/** O que aparece ao lado de FILME/SERIE: o servico de streaming ou, sem ele, o genero. */
const kindLabel = (item) => Providers.name(item.prov) || item.genres?.[0] || '';

function metaLine(parts, genre) {
  return [
    h('div', { class: 'meta-line' }, parts.filter(Boolean).map((p) => h('span', {}, p))),
    genre ? h('div', { class: 'genres' }, genre) : null,
  ];
}

/* --------------------------------------------------------------------- app */

const App = {
  stack: [],
  token: 0,
  timers: [],

  async init() {
    Player.init();
    this.applyScale(store.get('scale', 1));

    document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => this.go(b.dataset.view, {}, true)));
    $('#back').onclick = () => this.back();
    window.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', scrollY > 30), { passive: true });

    window.addEventListener('keydown', (e) => {
      if (Player.open_) return Player.onKey(e);
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
      if ((e.key === 'Escape' || (e.key === 'Backspace' && !typing)) && this.stack.length > 1) {
        e.preventDefault();
        this.back();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        this.go('search', {}, true);
      }
    });
    // Botao "voltar" lateral do mouse.
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 3) return;
      e.preventDefault();
      if (Player.open_) Player.close();
      else this.back();
    });

    this.splash('Carregando sua lista…');
    let first = true;
    try {
      await Data.load(() => {
        if (first) {
          first = false;
          this.go('home', {}, true);
          this.loadTrends();
        } else if (this.current?.name === 'home' && scrollY < 80) {
          this.render();
        }
      });
    } catch (err) {
      this.go('settings', { error: `Não consegui abrir a lista: ${err.message}` }, true);
      return;
    }
    if (!Data.cfg.server) this.go('settings', { error: 'Informe o servidor da sua lista para começar.' }, true);
  },

  /** Em alta nos streamings: entra assim que chegar, sem atrapalhar quem ja esta rolando a tela. */
  loadTrends() {
    Trends.load(() => {
      const name = this.current?.name;
      if ((name === 'home' || name === 'movies' || name === 'series') && scrollY < 80) this.render();
    });
  },

  applyScale(s) {
    document.documentElement.style.setProperty('--scale', s);
  },

  splash(msg) {
    const view = $('#view');
    view.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'spinner' }), h('p', {}, msg)));
  },

  get current() {
    return this.stack[this.stack.length - 1];
  },

  go(name, params = {}, root = false) {
    if (this.current) this.current.scroll = scrollY;
    if (root) this.stack = [];
    this.stack.push({ name, params });
    this.render();
    scrollTo(0, 0);
  },

  back() {
    if (this.stack.length < 2) return;
    this.stack.pop();
    this.render(this.current.scroll);
  },

  render(scroll) {
    const token = ++this.token;
    this.timers.forEach(clearInterval);
    this.timers = [];
    const { name, params } = this.current;
    const root = this.stack[0].name;
    document.querySelectorAll('#nav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === root));
    $('#back').classList.toggle('show', this.stack.length > 1);
    document.body.dataset.view = name;

    const view = $('#view');
    view.replaceChildren();
    const isLive = () => token === this.token;
    const fn = {
      home: this.viewHome,
      movies: () => this.viewBrowse('movie'),
      series: () => this.viewBrowse('series'),
      live: this.viewLive,
      mylist: this.viewMyList,
      search: this.viewSearch,
      settings: this.viewSettings,
      detail: this.viewDetail,
      grid: this.viewGrid,
    }[name];
    fn.call(this, view, params, isLive);
    if (scroll) requestAnimationFrame(() => scrollTo(0, scroll));
  },

  /** Recarrega a tela atual mantendo a rolagem (ex.: ao fechar o player). */
  refresh() {
    this.render(scrollY);
  },

  openItem(item, siblings) {
    if (item.kind === 'live') return this.playLive(item, siblings?.filter((x) => x.kind === 'live'));
    this.go('detail', { key: item.key });
  },

  /* --------------------------------------------------------------- tocar */

  playMovie(item, info, fromStart) {
    const p = Watch.get(item.key);
    const startAt = !fromStart && p && p.pos / p.dur < 0.92 ? p.pos : 0;
    Watch.touch(item, { tmdb: info?.tmdb || '' });
    Player.open({
      kind: 'vod',
      title: item.name,
      sub: [item.year, info?.genre].filter(Boolean).join('  ·  '),
      url: Data.streamUrl('movie', item.id, info?.ext || item.ext),
      key: item.key,
      startAt,
      onClose: () => this.refresh(),
    });
  },

  playEpisode(series, info, ep, fromStart) {
    const p = Watch.get(ep.key);
    const startAt = !fromStart && p && p.pos / p.dur < 0.92 ? p.pos : 0;
    const ref = (e) => ({ key: e.key, id: e.id, season: e.season, num: e.num, title: e.title, ext: e.ext });
    const next = this.nextEpisode(info, ep);
    Watch.touch(series, { ep: ref(ep), tmdb: info?.tmdb || '' });
    Player.open({
      kind: 'vod',
      title: series.name,
      sub: `T${ep.season}:E${ep.num}  ·  ${ep.title}`,
      url: Data.streamUrl('episode', ep.id, ep.ext),
      key: ep.key,
      startAt,
      next: next && { label: `T${next.season}:E${next.num} · ${next.title}`, play: () => this.playEpisode(series, info, next, true) },
      // Terminou o episodio: o "continuar assistindo" passa a apontar o proximo.
      onProgress: (pct) => {
        if (pct >= 0.92 && next) Watch.touch(series, { ep: ref(next) });
      },
      onClose: () => this.refresh(),
    });
  },

  nextEpisode(info, ep) {
    const seasons = info.seasons || [];
    const si = seasons.findIndex((s) => s.num === ep.season);
    if (si < 0) return null;
    const eps = seasons[si].episodes;
    const ei = eps.findIndex((e) => e.id === ep.id);
    if (eps[ei + 1]) return eps[ei + 1];
    const nextSeason = seasons[si + 1];
    return nextSeason && nextSeason.num !== 0 ? nextSeason.episodes[0] : null;
  },

  async resumeSeries(series, epRef) {
    toast('Abrindo…', 1500);
    try {
      const info = await Data.details(series);
      const ep = info.seasons.flatMap((s) => s.episodes).find((e) => e.id === epRef.id);
      if (ep) this.playEpisode(series, info, ep);
      else this.go('detail', { key: series.key });
    } catch {
      this.go('detail', { key: series.key });
    }
  },

  playLive(ch, channels) {
    if (!channels?.length) channels = Data.catById.get(`live:${ch.cat}`)?.items || [ch];
    Watch.touch(ch);
    Player.open({
      kind: 'live',
      title: ch.name,
      sub: Data.catName(ch),
      url: Data.streamUrl('live', ch.id, 'm3u8'),
      key: ch.key,
      streamId: ch.id,
      channels,
    });
  },

  /* ---------------------------------------------------------------- inicio */

  viewHome(view, _p, isLive) {
    if (!Data.ready) return this.splash('Carregando sua lista…');
    const year = new Date().getFullYear();

    view.append(this.hero(isLive));

    const rows = h('div', { class: 'rows' });
    view.append(rows);

    const cont = Watch.continueList();
    if (cont.length) {
      rows.append(
        row(
          'Continuar assistindo',
          cont.map((c) => ({
            item: c.item,
            pct: c.pct,
            sub: c.ep ? `T${c.ep.season}:E${c.ep.num}${c.pct > 0.02 ? '' : ' · próximo'}` : `${Math.max(1, Math.round(((1 - c.pct) * (Watch.get(c.item.key)?.dur || 0)) / 60))} min restantes`,
            onClick: () => (c.ep ? this.resumeSeries(c.item, c.ep) : this.playMovie(c.item, null)),
          })),
          { noMore: true }
        )
      );
    }

    const mine = Watch.mylist.map((k) => Data.byKey.get(k)).filter(Boolean);
    if (mine.length) rows.append(row('Minha lista', mine));

    const forYou = Recs.forYou();
    if (forYou.length) rows.append(row('Feito para você', forYou, { noMore: true }));

    // As linhas "Porque voce assistiu" dependem de detalhes/TMDB; entram quando chegarem.
    const because = h('div');
    rows.append(because);
    Recs.becauseYouWatched().then((list) => {
      if (!isLive()) return;
      for (const r of list) because.append(row(r.title, r.items, { noMore: true }));
    });

    if (Trends.ready) {
      const top10 = Trends.top(null, 'score', 10);
      rows.append(row('Top 10 de hoje nos streamings', top10.map((item, i) => ({ item, rank: i + 1 })), { noMore: true, top: true }));
      rows.append(row('Em alta agora', Trends.top(null, 'score', 50).slice(10), { noMore: true }));
      const air = Trends.top('series', 'air');
      if (air.length >= 4) rows.append(row('Séries com episódios novos', air, { noMore: true }));
      const fresh = Trends.top(null, 'fresh');
      if (fresh.length >= 4) rows.append(row('Lançamentos nos streamings', fresh, { noMore: true }));
      rows.append(row('Filmes em alta', Trends.top('movie'), { noMore: true }));
      rows.append(row('Séries em alta', Trends.top('series'), { noMore: true }));
    } else {
      const fresh = Recs.freshHits('movie');
      if (fresh.length >= 6) rows.append(row('Novidades bem avaliadas', fresh, { noMore: true }));
      rows.append(row('Séries com episódios novos', Recs.recentlyAdded('series'), { noMore: true }));
    }
    rows.append(row('Adicionados recentemente', Recs.recentlyAdded('movie'), { noMore: true }));

    const top = Recs.topOfYear('movie', year);
    if (top.length >= 6) rows.append(row(`Os melhores filmes de ${year}`, top, { noMore: true }));

    const liveRecent = Watch.history.map((x) => Data.byKey.get(x.key)).filter((x) => x?.kind === 'live');
    if (liveRecent.length) rows.append(row('Seus canais', liveRecent, { noMore: true }));

    // Alguns generos, filmes e series juntos, sorteados por dia para variar a tela inicial.
    for (const g of shuffle(Group.byGenre(null).slice(0, 14), daySeed()).slice(0, 6)) rows.append(row(g.title, g.items));
  },

  /** Destaque grande no topo, trocando a cada 12 segundos. */
  hero(isLive) {
    const recent = Date.now() - 60 * 86400000;
    const pick = (kind, n, minRating) =>
      Data.items[kind]
        .filter((x) => x.added >= recent && x.rating >= minRating && x.poster)
        .sort((a, b) => b.rating - a.rating)
        .slice(0, n * 3);
    let list = Trends.ready
      ? shuffle(Trends.top(null, 'score', 12).filter((x) => x.backdrop || x.tmdb), daySeed()).slice(0, 8)
      : shuffle([...pick('movie', 4, 6.5), ...pick('series', 3, 7)], daySeed()).slice(0, 7);
    if (!list.length) list = shuffle(Data.items.movie.filter((x) => x.rating >= 7), daySeed()).slice(0, 6);

    const bg = h('div', { class: 'hero-bg' });
    const body = h('div', { class: 'hero-body' });
    const dots = h('div', { class: 'hero-dots' });
    const el = h('div', { class: 'hero' }, bg, h('div', { class: 'hero-shade' }), body, dots);
    if (!list.length) return el;

    let index = -1;
    const show = async (i) => {
      index = (i + list.length) % list.length;
      const item = list[index];
      dots.replaceChildren(...list.map((_, j) => h('button', { class: j === index ? 'on' : '', onclick: () => show(j) })));

      let info = {};
      try {
        info = await Data.details(item);
      } catch {}
      if (!isLive() || list[index] !== item) return;

      const img = h('img', { src: info.backdrop || item.backdrop || info.poster || item.poster, alt: '', class: info.backdrop || item.backdrop ? '' : 'blur' });
      img.onload = () => {
        img.classList.add('in');
        [...bg.children].slice(0, -1).forEach((old) => setTimeout(() => old.remove(), 900));
      };
      bg.append(img);

      const inList = Watch.inList(item.key);
      // Na TV o foco pode estar num botao do destaque; ele continua no mesmo lugar ao trocar.
      const focused = [...body.querySelectorAll('button')].findIndex((b) => b === document.activeElement || b.classList.contains('tv-focus'));
      fill(body,
        h('div', { class: 'hero-kind' }, item.kind === 'movie' ? 'FILME' : 'SÉRIE', h('span', {}, kindLabel(item))),
        info.logo ? h('img', { class: 'hero-logo', src: info.logo, alt: item.name }) : h('h1', { class: 'hero-title' }, item.name),
        metaLine([item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : '', fmtDuration(info.duration), info.seasons ? `${info.seasons.filter((s) => s.num).length} temporada(s)` : ''], info.genre),
        h('p', { class: 'hero-plot' }, info.plot || item.plot || ''),
        h(
          'div',
          { class: 'actions' },
          button('Assistir', 'play', () => (item.kind === 'movie' ? this.playMovie(item, info) : this.go('detail', { key: item.key })), 'primary'),
          button('Mais informações', 'info', () => this.go('detail', { key: item.key })),
          button(inList ? 'Na lista' : 'Minha lista', inList ? 'check' : 'plus', (e) => {
            const on = Watch.toggleList(item.key);
            e.currentTarget.replaceChildren(icon(on ? 'check' : 'plus'), h('span', {}, on ? 'Na lista' : 'Minha lista'));
          })
        )
      );
      const again = focused >= 0 && body.querySelectorAll('button')[focused];
      if (again) typeof Focus !== 'undefined' ? Focus.focus(again, false) : again.focus({ preventScroll: true });
    };
    show(0);
    this.timers.push(setInterval(() => document.hasFocus() && show(index + 1), 12000));
    // Pre-carrega os detalhes do proximo destaque.
    list.slice(1, 3).forEach((x) => Data.details(x).catch(() => {}));
    return el;
  },

  /* ------------------------------------------------------- filmes / series */

  viewBrowse(kind) {
    const view = $('#view');
    if (!Data.ready) return this.splash('Carregando sua lista…');
    const modeKey = `mode:${kind}`;
    let mode = store.get(modeKey, 'genre');
    if (!['genre', 'added', 'year'].includes(mode)) mode = 'genre';
    const label = kind === 'movie' ? 'Filmes' : 'Séries';

    view.append(
      h(
        'div',
        { class: 'page-head' },
        h('h1', {}, label, h('span', { class: 'count' }, `${Data.items[kind].length.toLocaleString('pt-BR')} títulos`)),
        chips(
          [
            ['genre', 'Destaques e gêneros'],
            ['added', kind === 'series' ? 'Atualizadas' : 'Adicionados'],
            ['year', 'Ano de lançamento'],
          ],
          mode,
          (v) => {
            store.set(modeKey, v);
            this.render();
          }
        )
      )
    );
    const rows = h('div', { class: 'rows' });
    view.append(rows);
    if (mode === 'genre') {
      if (Trends.ready) {
        rows.append(row(`${label} em alta nos streamings`, Trends.top(kind, 'score', 60), { noMore: true }));
        if (kind === 'series') {
          const air = Trends.top('series', 'air');
          if (air.length >= 4) rows.append(row('Com episódios novos', air, { noMore: true }));
        }
        const fresh = Trends.top(kind, 'fresh');
        if (fresh.length >= 4) rows.append(row('Lançamentos nos streamings', fresh, { noMore: true }));
      }
      rows.append(row(kind === 'series' ? 'Atualizadas recentemente' : 'Adicionados recentemente', Recs.recentlyAdded(kind), { noMore: true }));
    }
    const groups = mode === 'added' ? Group.byAdded(kind) : mode === 'year' ? Group.byYear(kind) : Group.byGenre(kind);
    for (const g of groups) rows.append(row(g.title, g.items, { count: true }));
  },

  viewLive(view) {
    if (!Data.ready) return this.splash('Carregando sua lista…');
    view.append(h('div', { class: 'page-head' }, h('h1', {}, 'Ao Vivo', h('span', { class: 'count' }, `${Data.items.live.length} canais`))));
    const rows = h('div', { class: 'rows' });
    view.append(rows);
    const recent = Watch.history.map((x) => Data.byKey.get(x.key)).filter((x) => x?.kind === 'live');
    if (recent.length) rows.append(row('Vistos recentemente', recent, { noMore: true }));
    for (const c of Data.cats.live) rows.append(row(c.name, c.items, { count: true, siblings: c.items }));
  },

  viewMyList(view) {
    const items = Watch.mylist.map((k) => Data.byKey.get(k)).filter(Boolean);
    view.append(h('div', { class: 'page-head' }, h('h1', {}, 'Minha Lista')));
    if (!items.length) {
      view.append(h('p', { class: 'empty' }, 'Nada aqui ainda. Abra um filme ou série e clique em “Minha lista”.'));
      return;
    }
    view.append(this.grid(items));
  },

  viewGrid(view, { title, items }) {
    view.append(h('div', { class: 'page-head' }, h('h1', {}, title, h('span', { class: 'count' }, items.length.toLocaleString('pt-BR')))));
    view.append(this.grid(items));
  },

  /** Grade que desenha de 60 em 60 conforme a rolagem desce. */
  grid(items) {
    const grid = h('div', { class: `grid${items[0]?.kind === 'live' ? ' grid-wide' : ''}` });
    const sentinel = h('div', { class: 'sentinel' });
    let shown = 0;
    const more = () => {
      append(grid, items.slice(shown, shown + 60).map((it) => card(it, { siblings: items })));
      shown += 60;
      if (shown >= items.length) io.disconnect();
    };
    const io = new IntersectionObserver((e) => e[0].isIntersecting && more(), { rootMargin: '1200px 0px' });
    more();
    requestAnimationFrame(() => io.observe(sentinel));
    return h('div', {}, grid, sentinel);
  },

  /* ------------------------------------------------------------------ busca */

  viewSearch(view, params) {
    const input = h('input', { class: 'search-input', placeholder: 'Buscar filmes, séries e canais', value: params.q || '', spellcheck: 'false' });
    const results = h('div', { class: 'search-results' });
    view.append(h('div', { class: 'page-head search-head' }, icon('search'), input), results);

    let timer;
    const run = () => {
      const q = norm(input.value);
      params.q = input.value;
      results.replaceChildren();
      if (q.length < 2) {
        results.append(h('p', { class: 'empty' }, 'Digite pelo menos 2 letras.'));
        return;
      }
      const words = q.split(' ');
      const match = (it) => {
        it._n ??= norm(it.name);
        return words.every((w) => it._n.includes(w));
      };
      const score = (it) => (it._n.startsWith(q) ? 2 : 0) + (it.rating || 0) / 10;
      let total = 0;
      for (const [kind, label] of [
        ['movie', 'Filmes'],
        ['series', 'Séries'],
        ['live', 'Canais'],
      ]) {
        const found = Data.items[kind].filter(match).sort((a, b) => score(b) - score(a));
        total += found.length;
        if (found.length) results.append(row(`${label}`, found, { count: true }));
      }
      if (!total) results.append(h('p', { class: 'empty' }, `Nada encontrado para “${input.value}”.`));
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 220);
    });
    run();
    setTimeout(() => input.focus(), 50);
  },

  /* --------------------------------------------------------------- detalhe */

  viewDetail(view, { key }, isLive) {
    const item = Data.byKey.get(key);
    if (!item) return view.append(h('p', { class: 'empty' }, 'Título não encontrado na lista.'));

    const bg = h('div', { class: 'detail-bg' });
    const body = h('div', { class: 'detail-body' });
    const extra = h('div', { class: 'detail-extra' });
    view.append(h('div', { class: 'detail' }, bg, h('div', { class: 'detail-shade' }), body), extra);

    const setBg = (src, blur) => {
      if (!src) return;
      const img = h('img', { src, alt: '', class: blur ? 'blur' : '' });
      img.onload = () => {
        img.classList.add('in');
        [...bg.children].slice(0, -1).forEach((o) => setTimeout(() => o.remove(), 900));
      };
      bg.append(img);
    };
    setBg(item.backdrop || item.poster, !item.backdrop);
    body.append(h('h1', { class: 'hero-title' }, item.name), h('div', { class: 'spinner small' }));

    Data.details(item)
      .then((info) => {
        if (!isLive()) return;
        if (info.backdrop && info.backdrop !== item.backdrop) setBg(info.backdrop, false);
        this.fillDetail(item, info, body, extra, isLive);
      })
      .catch((err) => {
        if (!isLive()) return;
        body.querySelector('.spinner')?.remove();
        body.append(h('p', { class: 'hero-plot' }, `Não consegui carregar os detalhes (${err.message}).`));
        if (item.kind === 'movie') body.append(h('div', { class: 'actions' }, button('Assistir', 'play', () => this.playMovie(item, null), 'primary')));
      });
  },

  fillDetail(item, info, body, extra, isLive) {
    const isMovie = item.kind === 'movie';
    const hist = Watch.history.find((x) => x.key === item.key);
    const realSeasons = (info.seasons || []).filter((s) => s.num);

    const actions = h('div', { class: 'actions' });
    if (isMovie) {
      const p = Watch.pct(item.key);
      if (p > 0.02 && p < 0.92) {
        const left = Math.round(((1 - p) * Watch.get(item.key).dur) / 60);
        actions.append(
          button(`Continuar · ${left} min`, 'play', () => this.playMovie(item, info), 'primary'),
          button('Do início', null, () => this.playMovie(item, info, true))
        );
      } else actions.append(button('Assistir', 'play', () => this.playMovie(item, info, true), 'primary'));
    } else {
      const all = info.seasons?.flatMap((s) => s.episodes) || [];
      const cur = hist?.ep && all.find((e) => e.id === hist.ep.id);
      const first = realSeasons[0]?.episodes[0] || all[0];
      if (cur) actions.append(button(`Continuar T${cur.season}:E${cur.num}`, 'play', () => this.playEpisode(item, info, cur), 'primary'));
      else if (first) actions.append(button(`Assistir T${first.season}:E${first.num}`, 'play', () => this.playEpisode(item, info, first, true), 'primary'));
    }
    const inList = Watch.inList(item.key);
    actions.append(
      button(inList ? 'Na lista' : 'Minha lista', inList ? 'check' : 'plus', (e) => {
        const on = Watch.toggleList(item.key);
        e.currentTarget.replaceChildren(icon(on ? 'check' : 'plus'), h('span', {}, on ? 'Na lista' : 'Minha lista'));
      })
    );
    if (info.trailer) actions.append(button('Trailer', 'film', () => native.openExternal(`https://www.youtube.com/watch?v=${info.trailer}`)));

    fill(body,
      h('div', { class: 'hero-kind' }, isMovie ? 'FILME' : 'SÉRIE', h('span', {}, kindLabel(item))),
      info.logo ? h('img', { class: 'hero-logo', src: info.logo, alt: item.name }) : h('h1', { class: 'hero-title' }, item.name),
      info.tagline ? h('p', { class: 'tagline' }, info.tagline) : null,
      metaLine([
        (info.release || '').slice(0, 4) || item.year,
        item.rating || info.vote ? `★ ${(item.rating || info.vote).toFixed(1)}` : '',
        isMovie ? fmtDuration(info.duration) : realSeasons.length ? `${realSeasons.length} temporada${realSeasons.length > 1 ? 's' : ''}` : '',
      ], info.genre),
      actions,
      h('p', { class: 'detail-plot' }, info.plot || 'Sem sinopse.'),
      info.cast ? h('p', { class: 'credits' }, h('b', {}, 'Elenco: '), info.cast) : null,
      info.director ? h('p', { class: 'credits' }, h('b', {}, 'Direção: '), info.director) : null
    );

    if (!isMovie && info.seasons?.length) extra.append(this.seasonsBlock(item, info, hist));

    let similar = (info.similar || []).filter((x) => x.key !== item.key);
    if (similar.length < 6) similar = similar.concat(Recs.sameVibe(item, new Set([item.key])));
    similar = [...new Map(similar.map((x) => [x.key, x])).values()].slice(0, 30);
    if (similar.length) extra.append(h('div', { class: 'rows' }, row('Títulos semelhantes', similar, { noMore: true })));
    if (!Data.cfg.tmdbKey && isLive()) extra.append(h('p', { class: 'hint' }, 'Dica: adicione a chave do TMDB em Ajustes para fundos em alta resolução e recomendações melhores.'));
  },

  seasonsBlock(series, info, hist) {
    const seasons = info.seasons;
    const startSeason = hist?.ep?.season ?? (seasons.find((s) => s.num) || seasons[0]).num;
    const list = h('div', { class: 'episodes' });
    const tabs = h('div', { class: 'chips seasons-tabs' });

    const showSeason = (num) => {
      tabs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', +c.dataset.num === num));
      const season = seasons.find((s) => s.num === num);
      list.replaceChildren(
        ...season.episodes.map((ep) => {
          const pct = Watch.pct(ep.key);
          const current = hist?.ep?.id === ep.id;
          return h(
            'button',
            { class: `episode${current ? ' current' : ''}`, onclick: () => this.playEpisode(series, info, ep) },
            h('div', { class: 'ep-num' }, ep.num),
            h(
              'div',
              { class: 'ep-thumb' },
              ep.image ? h('img', { src: ep.image, loading: 'lazy', alt: '', onerror: (e) => e.target.remove() }) : null,
              h('div', { class: 'ep-play' }, icon('play')),
              pct > 0.02 ? h('div', { class: 'card-progress' }, h('i', { style: { width: `${Math.min(1, pct) * 100}%` } })) : null
            ),
            h(
              'div',
              { class: 'ep-text' },
              h('div', { class: 'ep-title' }, ep.title, h('span', {}, fmtDuration(ep.duration))),
              h('p', {}, ep.plot || '')
            )
          );
        })
      );
    };

    for (const s of seasons) {
      tabs.append(h('button', { class: 'chip', 'data-num': s.num, onclick: () => showSeason(s.num) }, s.num ? `Temporada ${s.num}` : s.name));
    }
    showSeason(startSeason);
    return h('div', { class: 'seasons' }, h('h2', { class: 'row-title' }, 'Episódios'), tabs, list);
  },

  /* ---------------------------------------------------------------- ajustes */

  async viewSettings(view, params) {
    const cfg = await native.getConfig();
    const field = (label, input, help) => h('label', { class: 'field' }, h('span', {}, label), input, help ? h('small', {}, help) : null);
    const server = h('input', { value: cfg.server || '', placeholder: 'https://seu-editor.workers.dev' });
    const user = h('input', { value: cfg.user || '' });
    const pass = h('input', { value: cfg.pass || '', type: 'password' });
    const tmdbKey = h('input', { value: cfg.tmdbKey || '', placeholder: 'Cole aqui a chave da API ou o token de leitura', type: 'password' });
    const scale = store.get('scale', 1);

    view.append(
      h('div', { class: 'page-head' }, h('h1', {}, 'Ajustes')),
      h(
        'div',
        { class: 'settings' },
        params.error ? h('p', { class: 'error-box' }, params.error) : null,

        h('h2', {}, 'Tamanho da tela'),
        h('p', { class: 'muted' }, 'Aumente se estiver longe da TV.'),
        chips(
          [
            [0.85, 'Compacto'],
            [1, 'Normal'],
            [1.18, 'Grande'],
            [1.35, 'Enorme'],
          ],
          scale,
          (v) => {
            store.set('scale', v);
            this.applyScale(v);
            this.refresh();
          }
        ),

        h('h2', {}, 'TMDB (capas e recomendações)'),
        h(
          'p',
          { class: 'muted' },
          'Com a chave gratuita do TMDB o app junta o que está em alta na Netflix, Prime Video, Disney+, HBO Max e outros, e mostra fundos em alta resolução, logotipos, elenco e títulos parecidos. ',
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), native.openExternal('https://www.themoviedb.org/settings/api')) }, 'Pegar minha chave no site do TMDB')
        ),
        field('Chave do TMDB', tmdbKey),
        h(
          'div',
          { class: 'actions' },
          button('Salvar chave', 'check', async () => {
            await native.setConfig({ tmdbKey: tmdbKey.value.trim() });
            Data.cfg.tmdbKey = tmdbKey.value.trim();
            Data.infoCache.clear();
            if (!Data.cfg.tmdbKey) return toast('Chave removida.');
            try {
              const ok = await native.tmdb('/configuration');
              toast(ok ? 'Chave do TMDB funcionando! Buscando o que está em alta…' : 'O TMDB não aceitou essa chave.');
              if (ok) this.loadTrends();
            } catch (err) {
              toast(`O TMDB recusou a chave (${err.message}).`);
            }
          }, 'primary')
        ),

        h('h2', {}, 'Sua lista'),
        h('p', { class: 'muted' }, 'Os mesmos dados do modo Xtream do MEUS-DADOS.txt.'),
        field('Servidor', server),
        field('Usuário', user),
        field('Senha', pass),
        h(
          'div',
          { class: 'actions' },
          button('Salvar e recarregar', 'check', async () => {
            await native.setConfig({ server: server.value.trim().replace(/\/+$/, ''), user: user.value.trim(), pass: pass.value.trim() });
            location.reload();
          }, 'primary'),
          button('Atualizar catálogo agora', null, async () => {
            toast('Atualizando…');
            try {
              const raw = await Data.fetchAll();
              Data.apply(raw);
              native.cacheSet('catalog', raw);
              toast(`Pronto: ${Data.items.movie.length} filmes, ${Data.items.series.length} séries, ${Data.items.live.length} canais.`);
            } catch (err) {
              toast(`Falhou: ${err.message}`);
            }
          })
        ),
        Data.loadedAt ? h('p', { class: 'muted' }, `Catálogo baixado em ${new Date(Data.loadedAt).toLocaleString('pt-BR')}.`) : null,

        h('h2', {}, 'Histórico'),
        h(
          'div',
          { class: 'actions' },
          button('Limpar “Continuar assistindo”', null, () => {
            if (!confirm('Apagar o histórico e o progresso de tudo que você assistiu?')) return;
            Watch.history = [];
            Watch.progress = {};
            store.set('history', []);
            store.set('progress', {});
            toast('Histórico apagado.');
          }),
          button('Fechar o app', 'close', () => native.quit())
        )
      )
    );
  },
};

App.init();
