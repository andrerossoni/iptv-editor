/**
 * Catalogo (lista publicada pelo Worker), detalhes, TMDB, progresso e recomendacoes.
 *
 * Os itens viram um formato unico — { kind, id, key, name, year, poster, ... } —
 * para que as telas nao precisem saber de onde cada campo veio.
 */

const TMDB_IMG = 'https://image.tmdb.org/t/p/';
const tmdbImg = (p, size = 'w780') => (p ? (p.startsWith('http') ? p : TMDB_IMG + size + p) : '');
const firstOf = (v) => (Array.isArray(v) ? v.find(Boolean) : v) || '';

const Data = {
  cfg: {},
  cats: { movie: [], series: [], live: [] },
  items: { movie: [], series: [], live: [] },
  byKey: new Map(),
  byTitle: new Map(),
  infoCache: new Map(),
  loadedAt: 0,

  get ready() {
    return this.byKey.size > 0;
  },

  apiUrl(action, params = {}) {
    const q = new URLSearchParams({ username: this.cfg.user, password: this.cfg.pass, action, ...params });
    return `${this.cfg.server}/player_api.php?${q}`;
  },

  async api(action, params) {
    const res = await fetch(this.apiUrl(action, params));
    if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
    return res.json();
  },

  /**
   * Abre com a copia salva (instantaneo) e atualiza pela rede em seguida.
   * Copia de menos de 20 minutos nao e baixada de novo, e se o servidor
   * devolver a mesma lista a tela nao e redesenhada.
   */
  async load(onChange) {
    this.cfg = await native.getConfig();
    const cached = await native.cacheGet('catalog');
    if (cached) {
      this.apply(cached);
      onChange();
    }
    if (!this.cfg.server) return;
    if (cached && Date.now() - (cached.at || 0) < 20 * 60000) return;
    try {
      const raw = await this.fetchAll();
      if (cached && this.signature(raw) === this.signature(cached)) {
        native.cacheSet('catalog', raw);
        return;
      }
      this.apply(raw);
      native.cacheSet('catalog', raw);
      onChange();
    } catch (err) {
      if (!cached) throw err;
      toast('Sem conexão com o servidor — mostrando a última cópia salva.');
    }
  },

  /** Resumo barato da lista: muda se entrar, sair ou atualizar qualquer titulo. */
  signature(raw) {
    const sum = (list, f) => (Array.isArray(list) ? list.reduce((a, x) => a + (+x[f] || 0), list.length) : 0);
    return [sum(raw.v, 'added'), sum(raw.s, 'last_modified'), sum(raw.l, 'stream_id'), (raw.vc || []).length, (raw.sc || []).length, (raw.lc || []).length].join('|');
  },

  async fetchAll() {
    const actions = ['get_vod_categories', 'get_series_categories', 'get_live_categories', 'get_vod_streams', 'get_series', 'get_live_streams'];
    const [vc, sc, lc, v, s, l] = await Promise.all(actions.map((a) => this.api(a)));
    return { vc, sc, lc, v, s, l, at: Date.now() };
  },

  apply(raw) {
    const asArray = (x) => (Array.isArray(x) ? x : []);
    this.byKey = new Map();
    this.byTitle = new Map();
    this.loadedAt = raw.at || Date.now();

    const movies = asArray(raw.v).map((x) => ({
      kind: 'movie',
      id: String(x.stream_id),
      key: `movie:${x.stream_id}`,
      name: x.name || x.title || '',
      year: String(x.year || '').slice(0, 4),
      poster: x.stream_icon || '',
      rating: parseFloat(x.rating) || 0,
      added: (+x.added || 0) * 1000,
      cat: String(x.category_id),
      ext: x.container_extension || 'mp4',
    }));

    const series = asArray(raw.s).map((x) => ({
      kind: 'series',
      id: String(x.series_id),
      key: `series:${x.series_id}`,
      name: x.name || x.title || '',
      year: String(x.year || x.release_date || x.releaseDate || '').slice(0, 4),
      poster: x.cover || '',
      backdrop: firstOf(x.backdrop_path),
      rating: parseFloat(x.rating) || 0,
      added: (+x.last_modified || 0) * 1000,
      cat: String(x.category_id),
      plot: x.plot || '',
      genre: x.genre || '',
      cast: x.cast || '',
      trailer: x.youtube_trailer || '',
      tmdb: x.tmdb || x.tmdb_id || '',
    }));

    const live = asArray(raw.l).map((x) => ({
      kind: 'live',
      id: String(x.stream_id),
      key: `live:${x.stream_id}`,
      name: x.name || '',
      poster: x.stream_icon || '',
      cat: String(x.category_id),
      added: (+x.added || 0) * 1000,
      epg: x.epg_channel_id || '',
    }));

    this.items = { movie: movies, series, live };

    const buildCats = (list, items, kind) => {
      const cats = asArray(list).map((c) => ({ id: String(c.category_id), name: c.category_name, kind, items: [] }));
      const map = new Map(cats.map((c) => [c.id, c]));
      // A ordem dos itens e a mesma que voce deixou no editor.
      for (const it of items) map.get(it.cat)?.items.push(it);
      return cats.filter((c) => c.items.length);
    };
    this.cats = {
      movie: buildCats(raw.vc, movies, 'movie'),
      series: buildCats(raw.sc, series, 'series'),
      live: buildCats(raw.lc, live, 'live'),
    };
    this.catById = new Map([...this.cats.movie, ...this.cats.series, ...this.cats.live].map((c) => [`${c.kind}:${c.id}`, c]));

    for (const it of [...movies, ...series, ...live]) {
      this.byKey.set(it.key, it);
      if (it.kind === 'live') continue;
      const folder = this.catName(it);
      it.adult = /\[(xxx|adulto)\]/i.test(it.name) || /^private$/i.test(folder);
      // Genero e servico vem primeiro da pasta/ficha do provedor; o TMDB corrige depois.
      it.genres = Genres.fromFolder(folder, it.kind === 'series' ? it.genre : '');
      it.prov = Providers.fromFolder(folder);
      const clean = cleanTitle(it.name);
      // Nome so com letras nao latinas (japones, grego...) fica vazio: nao da para cruzar.
      if (clean.length < 2) continue;
      const tk = `${it.kind}|${clean}`;
      if (!this.byTitle.has(tk)) this.byTitle.set(tk, []);
      this.byTitle.get(tk).push(it);
    }
    Trends.apply();
  },

  catName(item) {
    return this.catById?.get(`${item.kind}:${item.cat}`)?.name || '';
  },

  streamUrl(kind, id, ext) {
    const path = { movie: 'movie', episode: 'series', live: 'live' }[kind];
    const { server, user, pass } = this.cfg;
    return `${server}/${path}/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.${ext}`;
  },

  /* ------------------------------------------------------------ detalhes */

  /**
   * Detalhes ficam guardados no disco entre aberturas: filme por 3 dias, serie
   * por 6 horas (pode ganhar episodio). O destaque do inicio abre sem esperar.
   */
  async details(item) {
    if (this.infoCache.has(item.key)) return this.infoCache.get(item.key);
    const ttl = item.kind === 'movie' ? 3 * 86400000 : 6 * 3600000;
    const name = `info-${item.key.replace(':', '-')}`;
    const promise = (async () => {
      const saved = await native.cacheGet(name).catch(() => null);
      if (saved && Date.now() - saved.at < ttl && !!saved.info.tmdbData === !!this.cfg.tmdbKey) return this.relink(item, saved.info);
      const info = await (item.kind === 'movie' ? this.movieInfo(item) : this.seriesInfo(item));
      // tmdbData e grande e so serve para montar o resto; os "semelhantes" viram chaves.
      const { tmdbData, similar, ...rest } = info;
      native.cacheSet(name, { at: Date.now(), info: { ...rest, tmdbData: !!tmdbData, similar: (similar || []).map((x) => x.key) } });
      return info;
    })().catch((err) => {
      this.infoCache.delete(item.key);
      throw err;
    });
    this.infoCache.set(item.key, promise);
    return promise;
  },

  /** Detalhes vindos do disco: os "semelhantes" voltam a ser itens da lista atual. */
  relink(item, info) {
    const similar = (info.similar || []).map((k) => this.byKey.get(k)).filter(Boolean);
    if (info.prov) item.prov ||= info.prov;
    return { ...info, similar };
  },

  async movieInfo(item) {
    const d = await this.api('get_vod_info', { vod_id: item.id });
    const i = d.info || {};
    const out = {
      plot: i.plot || i.description || '',
      cast: i.cast || i.actors || '',
      director: i.director || '',
      genre: i.genre || '',
      duration: +i.duration_secs || (+i.episode_run_time || 0) * 60,
      backdrop: firstOf(i.backdrop_path),
      poster: i.cover_big || i.movie_image || item.poster,
      tmdb: i.tmdb_id || item.tmdb || '',
      trailer: i.youtube_trailer || '',
      release: i.release_date || i.releasedate || '',
      ext: d.movie_data?.container_extension || item.ext,
    };
    return this.enrich(item, out);
  },

  async seriesInfo(item) {
    const d = await this.api('get_series_info', { series_id: item.id });
    const i = d.info || {};
    const seasonMeta = new Map((d.seasons || []).map((s) => [String(s.season_number), s]));
    const seasons = Object.entries(d.episodes || {})
      .map(([num, eps]) => ({
        num: +num,
        name: +num === 0 ? 'Especiais' : seasonMeta.get(num)?.name || `Temporada ${num}`,
        episodes: (eps || [])
          .map((e) => ({
            id: String(e.id),
            key: `ep:${e.id}`,
            num: +e.episode_num || 0,
            season: +num,
            title: (e.title || '').replace(/^.*S\d+E\d+\s*-\s*/i, '') || `Episódio ${e.episode_num}`,
            ext: e.container_extension || 'mp4',
            plot: e.info?.plot || '',
            duration: +e.info?.duration_secs || 0,
            image: e.info?.movie_image || e.info?.cover_big || '',
          }))
          .sort((a, b) => a.num - b.num),
      }))
      .filter((s) => s.episodes.length)
      .sort((a, b) => (a.num || 999) - (b.num || 999));

    const out = {
      plot: i.plot || item.plot,
      cast: i.cast || item.cast,
      director: i.director || '',
      genre: i.genre || item.genre,
      backdrop: firstOf(i.backdrop_path) || item.backdrop,
      poster: i.cover || item.poster,
      tmdb: i.tmdb_id || i.tmdb || item.tmdb || '',
      trailer: i.youtube_trailer || item.trailer,
      release: i.releaseDate || i.release_date || '',
      seasons,
    };
    return this.enrich(item, out);
  },

  /** Com chave do TMDB: fundo em alta, logotipo, sinopse em pt-BR, elenco e titulos parecidos. */
  async enrich(item, out) {
    if (!this.cfg.tmdbKey || !out.tmdb) return out;
    const type = item.kind === 'movie' ? 'movie' : 'tv';
    let t;
    try {
      t = await native.tmdb(`/${type}/${out.tmdb}?language=pt-BR&append_to_response=images,videos,recommendations,similar,credits,watch/providers&include_image_language=pt,en,null`);
    } catch {
      return out;
    }
    if (!t) return out;

    const logos = t.images?.logos || [];
    const logo = logos.find((l) => l.iso_639_1 === 'pt') || logos.find((l) => l.iso_639_1 === 'en') || logos[0];
    const backdrops = (t.images?.backdrops || []).filter((b) => !b.iso_639_1);
    const trailer = (t.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');

    out.tmdbData = t;
    out.backdrop = t.backdrop_path ? tmdbImg(backdrops[0]?.file_path || t.backdrop_path, 'original') : out.backdrop;
    out.logo = logo ? tmdbImg(logo.file_path, 'w500') : '';
    out.plot = t.overview || out.plot;
    out.genre = (t.genres || []).map((g) => g.name).join(', ') || out.genre;
    out.duration = out.duration || (t.runtime || 0) * 60;
    out.tagline = t.tagline || '';
    out.vote = t.vote_average || 0;
    out.cert = '';
    if (trailer) out.trailer = trailer.key;
    const cast = (t.credits?.cast || []).slice(0, 6).map((c) => c.name);
    if (cast.length) out.cast = cast.join(', ');
    out.similar = this.matchTmdb(item.kind, [...(t.recommendations?.results || []), ...(t.similar?.results || [])]);
    const br = t['watch/providers']?.results?.BR?.flatrate || [];
    const prov = Providers.best(br.map((p) => p.provider_id));
    if (prov) item.prov = out.prov = prov;
    return out;
  },

  /** Traz do TMDB so o que existe na sua lista (o resto nao daria para assistir). */
  matchTmdb(kind, results) {
    const seen = new Set();
    const out = [];
    for (const r of results) {
      const hit = this.findTmdb(kind, r);
      if (hit && !seen.has(hit.key)) {
        seen.add(hit.key);
        out.push(hit);
      }
    }
    return out;
  },

  /** Acha na sua lista um resultado do TMDB pelo titulo (em portugues ou original) e ano. */
  findTmdb(kind, r) {
    const year = +String(r.release_date || r.first_air_date || '').slice(0, 4);
    for (const title of [r.title, r.name, r.original_title, r.original_name]) {
      const clean = cleanTitle(title);
      const list = clean.length >= 2 && this.byTitle.get(`${kind}|${clean}`);
      if (!list) continue;
      // O ano do provedor as vezes e o da estreia no Brasil; aceita um de diferenca.
      const hit = list.find((x) => !year || !+x.year || Math.abs(+x.year - year) <= 1);
      if (hit) return hit;
    }
    return null;
  },

  async shortEpg(streamId) {
    try {
      const d = await this.api('get_short_epg', { stream_id: streamId, limit: 2 });
      const dec = (s) => {
        try {
          return decodeURIComponent(escape(atob(s || '')));
        } catch {
          return s || '';
        }
      };
      return (d.epg_listings || []).map((e) => ({
        title: dec(e.title),
        start: +e.start_timestamp * 1000,
        end: +e.stop_timestamp * 1000,
      }));
    } catch {
      return [];
    }
  },
};

/* ---------------------------------------------------------- progresso */

const Watch = {
  progress: store.get('progress', {}),
  history: store.get('history', []),
  mylist: store.get('mylist', []),

  get(key) {
    return this.progress[key];
  },

  pct(key) {
    const p = this.progress[key];
    return p && p.dur ? p.pos / p.dur : 0;
  },

  save(key, pos, dur) {
    if (!dur || !isFinite(dur)) return;
    this.progress[key] = { pos, dur, t: Date.now() };
    store.set('progress', this.progress);
  },

  /** Registra o titulo no historico; para serie guarda tambem o episodio. */
  touch(item, extra = {}) {
    const prev = this.history.find((x) => x.key === item.key) || {};
    this.history = [{ ...prev, key: item.key, t: Date.now(), ...extra }, ...this.history.filter((x) => x.key !== item.key)].slice(0, 200);
    store.set('history', this.history);
  },

  forget(key) {
    this.history = this.history.filter((x) => x.key !== key);
    store.set('history', this.history);
  },

  inList(key) {
    return this.mylist.includes(key);
  },

  toggleList(key) {
    this.mylist = this.inList(key) ? this.mylist.filter((k) => k !== key) : [key, ...this.mylist];
    store.set('mylist', this.mylist);
    return this.inList(key);
  },

  /** "Continuar assistindo": filmes pela metade e series com episodio em andamento ou o proximo. */
  continueList() {
    const out = [];
    for (const h of this.history) {
      const item = Data.byKey.get(h.key);
      if (!item || item.kind === 'live') continue;
      if (item.kind === 'movie') {
        const p = this.pct(item.key);
        if (p > 0.02 && p < 0.92) out.push({ item, pct: p });
      } else if (h.ep) {
        const p = this.pct(h.ep.key);
        if (p < 0.92) out.push({ item, pct: p, ep: h.ep });
      }
      if (out.length >= 30) break;
    }
    return out;
  },
};

/* ----------------------------------------------------- recomendacoes */

/** Itens que podem aparecer nas fileiras (conteudo adulto so aparece na busca). */
/**
 * Contas sobre o catalogo inteiro (generos, anos, recomendacoes) ficam
 * guardadas ate o catalogo ou o "em alta" mudar: trocar de aba nao refaz tudo.
 */
const Memo = {
  data: new Map(),
  clear() {
    this.data.clear();
  },
  get(key, fn) {
    if (!this.data.has(key)) this.data.set(key, fn());
    return this.data.get(key);
  },
};

/** O que voce assistiu muda algumas fileiras: entra na chave delas. */
const watchSig = () => `${Watch.history.length}|${Watch.history.slice(0, 5).map((x) => `${x.key}@${x.t}`).join(',')}`;

const pool = (kind) => Memo.get(`pool:${kind}`, () => (kind ? Data.items[kind] : [...Data.items.movie, ...Data.items.series]).filter((x) => !x.adult)).slice();

/** Nota geral de um titulo: em alta nos streamings pesa mais, depois avaliacao e novidade. */
const rank = (x) => (x.trend?.score || 0) * 4 + (x.rating || 0) / 2 + (Date.now() - x.added < 60 * 86400000 ? 1 : 0);

/** Ordena pela nota calculando cada uma uma vez so (o sort compara cada item muitas vezes). */
const sortByRank = (list) => {
  const r = new Map(list.map((x) => [x, rank(x)]));
  return list.sort((a, b) => r.get(b) - r.get(a));
};

const Recs = {
  watchedKeys() {
    return new Set(this.recent().map((x) => x.key));
  },

  recent() {
    return Watch.history.map((h) => ({ ...h, item: Data.byKey.get(h.key) })).filter((h) => h.item && h.item.kind !== 'live');
  },

  /** Novidades: adicionados nos ultimos 45 dias, os melhores primeiro. */
  freshHits(kind) {
    return Memo.get(`fresh:${kind}`, () => {
      const since = Date.now() - 45 * 86400000;
      return sortByRank(pool(kind).filter((x) => x.added >= since && x.rating >= 6)).slice(0, 40);
    });
  },

  recentlyAdded(kind) {
    return Memo.get(`added:${kind}`, () => pool(kind).sort((a, b) => b.added - a.added).slice(0, 40));
  },

  topOfYear(kind, year) {
    return Memo.get(`year:${kind}:${year}`, () => sortByRank(pool(kind).filter((x) => x.year === String(year) && x.rating > 0)).slice(0, 40));
  },

  /** Pontua generos e servicos pelo que voce assistiu e sugere o melhor ainda nao visto. */
  forYou() {
    return Memo.get(`foryou:${watchSig()}`, () => this.computeForYou());
  },

  computeForYou() {
    const recent = this.recent().slice(0, 40);
    if (!recent.length) return [];
    const watched = this.watchedKeys();
    const taste = new Map();
    const kinds = new Map();
    recent.forEach((h, i) => {
      const w = 1 / (1 + i * 0.15);
      for (const g of h.item.genres) taste.set(g, (taste.get(g) || 0) + w);
      if (h.item.prov) taste.set(`p:${h.item.prov}`, (taste.get(`p:${h.item.prov}`) || 0) + w / 2);
      kinds.set(h.item.kind, (kinds.get(h.item.kind) || 0) + w);
    });
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    return pool()
      .filter((x) => !watched.has(x.key) && x.genres.length)
      .map((x) => {
        let fit = 0;
        for (const g of x.genres) fit += taste.get(g) || 0;
        fit = fit / Math.sqrt(x.genres.length) + (taste.get(`p:${x.prov}`) || 0);
        return { x, s: (fit / total) * 6 * (0.4 + (kinds.get(x.kind) || 0) / total) + rank(x) / 3 };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.x);
  },

  /** "Porque voce assistiu X": TMDB quando houver chave; senao, genero parecido. */
  async becauseYouWatched() {
    const rows = [];
    const watched = this.watchedKeys();
    for (const h of this.recent().slice(0, 2)) {
      let items = [];
      try {
        const info = await Data.details(h.item);
        items = (info.similar || []).filter((x) => !watched.has(x.key) && !x.adult);
        if (items.length < 6) items = items.concat(this.sameVibe(h.item, watched));
      } catch {
        items = this.sameVibe(h.item, watched);
      }
      const unique = [...new Map(items.map((x) => [x.key, x])).values()].slice(0, 30);
      if (unique.length >= 4) rows.push({ title: `Porque você assistiu ${h.item.name}`, items: unique });
    }
    return rows;
  },

  sameVibe(item, watched) {
    return Memo.get(`vibe:${item.key}:${watchSig()}`, () => this.computeVibe(item, watched));
  },

  computeVibe(item, watched) {
    const genres = new Set(item.genres);
    return pool(item.kind)
      .filter((x) => x.key !== item.key && !watched.has(x.key))
      .map((x) => ({ x, s: x.genres.filter((g) => genres.has(g)).length * 3 + rank(x) }))
      .filter((r) => r.s > 3 || !genres.size)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((r) => r.x);
  },
};

/* ------------------------------------------------------ agrupamentos */

const Group = {
  /** Uma fileira por genero, na ordem de GENRE_ORDER; cada uma com o que esta em alta primeiro. */
  byGenre(kind) {
    return Memo.get(`genre:${kind}`, () => this.computeGenre(kind));
  },

  computeGenre(kind) {
    const buckets = new Map();
    for (const it of pool(kind)) {
      for (const g of it.genres) {
        if (!buckets.has(g)) buckets.set(g, []);
        buckets.get(g).push(it);
      }
    }
    const order = (g) => (GENRE_ORDER.indexOf(g) + 1 || 99);
    return [...buckets.entries()]
      .filter(([, items]) => items.length >= 8)
      .sort((a, b) => order(a[0]) - order(b[0]) || b[1].length - a[1].length)
      .map(([title, items]) => ({ title, items: sortByRank(items) }));
  },

  byAdded(kind) {
    return Memo.get(`byadded:${kind}`, () => this.computeAdded(kind));
  },

  computeAdded(kind) {
    const now = Date.now();
    const day = 86400000;
    const buckets = new Map();
    const push = (title, it) => {
      if (!buckets.has(title)) buckets.set(title, []);
      buckets.get(title).push(it);
    };
    const sorted = pool(kind).sort((a, b) => b.added - a.added);
    const verb = kind === 'series' ? 'Atualizadas' : 'Adicionados';
    for (const it of sorted) {
      const age = now - it.added;
      if (!it.added) push('Sem data', it);
      else if (age < 7 * day) push(`${verb} nesta semana`, it);
      else if (age < 30 * day) push(`${verb} neste mês`, it);
      else if (age < 365 * day) {
        const d = new Date(it.added);
        push(`${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} de ${d.getFullYear()}`, it);
      } else push('Há mais de um ano', it);
    }
    return [...buckets.entries()].map(([title, items]) => ({ title, items }));
  },

  byYear(kind) {
    return Memo.get(`byyear:${kind}`, () => this.computeYear(kind));
  },

  computeYear(kind) {
    const buckets = new Map();
    for (const it of pool(kind)) {
      const y = +it.year;
      const title = !y ? 'Ano desconhecido' : y < 1980 ? 'Clássicos (antes de 1980)' : y < 2000 ? `Anos ${Math.floor(y / 10) * 10}` : String(y);
      if (!buckets.has(title)) buckets.set(title, []);
      buckets.get(title).push(it);
    }
    const order = (t) => (/^\d{4}$/.test(t) ? +t : t.startsWith('Anos') ? +t.slice(5) : t.startsWith('Cl') ? 1 : 0);
    return [...buckets.entries()]
      .sort((a, b) => order(b[0]) - order(a[0]))
      .map(([title, items]) => ({ title, items: sortByRank(items) }));
  },
};
