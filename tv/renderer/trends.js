/**
 * Streamings unificados: o TMDB (dados do JustWatch) diz o que esta em alta e o
 * que estreou em cada servico no Brasil. Cruzamos com a sua lista e juntamos
 * tudo numa ordem so, com Netflix, Prime Video, Disney+ e HBO Max na frente.
 *
 * As pastas do provedor ("Em exibicao", "AMC Plus"...) nao aparecem mais: delas
 * so aproveitamos o genero e, sem TMDB, um palpite do servico.
 */

const TREND_TTL = 12 * 3600 * 1000;

const PROVIDERS = [
  { id: 8, name: 'Netflix', weight: 1, folders: ['netflix'] },
  { id: 119, name: 'Prime Video', weight: 1, folders: ['amazon', 'prime video'] },
  { id: 337, name: 'Disney+', weight: 1, folders: ['disney plus', 'star plus'] },
  { id: 1899, name: 'HBO Max', weight: 1, folders: ['hbo max', 'max'] },
  { id: 350, name: 'Apple TV+', weight: 0.55, folders: ['apple tv'] },
  { id: 307, name: 'Globoplay', weight: 0.55, folders: ['globoplay', 'novelinhas globoplay'] },
  { id: 531, name: 'Paramount+', weight: 0.55, folders: ['paramount'] },
  { id: 283, name: 'Crunchyroll', weight: 0.4, folders: ['crunchyroll', 'anime desenhos crunchyroll', 'funimation now'] },
  { id: 167, name: 'Claro video', weight: 0.4, folders: ['claro video'] },
];

const Providers = {
  byId: new Map(PROVIDERS.map((p) => [p.id, p])),
  logos: {},

  name(id) {
    return this.byId.get(id)?.name || '';
  },

  logo(id) {
    return this.logos[id] ? tmdbImg(this.logos[id], 'w92') : '';
  },

  /** Entre varios servicos, fica o de maior peso (a ordem de PROVIDERS desempata). */
  best(ids) {
    return PROVIDERS.find((p) => ids.includes(p.id))?.id || 0;
  },

  fromFolder(folder) {
    const f = norm(folder);
    return PROVIDERS.find((p) => p.folders.includes(f))?.id || 0;
  },
};

/* ---------------------------------------------------------------- generos */

/** Ordem das fileiras de genero em Filmes e Series. */
const GENRE_ORDER = [
  'Ação', 'Comédia', 'Suspense', 'Drama', 'Ficção científica', 'Terror', 'Aventura', 'Fantasia', 'Animação',
  'Crime', 'Romance', 'Mistério', 'Super-heróis', 'Animes', 'Doramas', 'Documentário', 'Família', 'Infantil',
  'Nacionais', 'Novelas', 'Reality shows', 'Programas de TV', 'Faroeste', 'Guerra', 'História', 'Música',
  'Religiosos', 'Natal', 'Talk shows',
];

/** Nomes de genero (TMDB em pt-BR, ingles que ele nao traduz, e pastas do provedor) para o rotulo do app. */
const GENRE_NAMES = {
  acao: 'Ação', action: 'Ação', aventura: 'Aventura', adventure: 'Aventura', animacao: 'Animação',
  comedia: 'Comédia', crime: 'Crime', policiais: 'Crime', documentario: 'Documentário', documentarios: 'Documentário',
  drama: 'Drama', familia: 'Família', fantasia: 'Fantasia', historia: 'História', terror: 'Terror',
  musica: 'Música', misterio: 'Mistério', romance: 'Romance', 'ficcao cientifica': 'Ficção científica',
  ficcao: 'Ficção científica', thriller: 'Suspense', suspense: 'Suspense', guerra: 'Guerra', faroeste: 'Faroeste',
  western: 'Faroeste', 'action adventure': ['Ação', 'Aventura'], 'sci fi fantasy': ['Ficção científica', 'Fantasia'],
  'war politics': 'Guerra', kids: 'Infantil', soap: 'Novelas', novelas: 'Novelas', 'novelinhas globoplay': 'Novelas',
  reality: 'Reality shows', talk: 'Talk shows', natal: 'Natal', nacionais: 'Nacionais', religiosos: 'Religiosos',
  marvel: 'Super-heróis', dc: 'Super-heróis', dorama: 'Doramas', 'programas de tv': 'Programas de TV',
  'anime desenhos crunchyroll': 'Animes', crunchyroll: 'Animes', 'funimation now': 'Animes',
};

const TMDB_GENRES = {
  28: 'Ação', 12: 'Aventura', 16: 'Animação', 35: 'Comédia', 80: 'Crime', 99: 'Documentário', 18: 'Drama',
  10751: 'Família', 14: 'Fantasia', 36: 'História', 27: 'Terror', 10402: 'Música', 9648: 'Mistério',
  10749: 'Romance', 878: 'Ficção científica', 53: 'Suspense', 10752: 'Guerra', 37: 'Faroeste',
  10759: ['Ação', 'Aventura'], 10762: 'Infantil', 10764: 'Reality shows', 10765: ['Ficção científica', 'Fantasia'],
  10766: 'Novelas', 10767: 'Talk shows', 10768: 'Guerra',
};

const Genres = {
  /** Generos de um item: o texto de genero da ficha (series) mais o que a pasta indicar. */
  fromFolder(folder, genreText) {
    const out = new Set();
    for (const g of String(genreText || '').split(/[,/;|]/)) [GENRE_NAMES[norm(g)]].flat().forEach((x) => x && out.add(x));
    [GENRE_NAMES[norm(folder)]].flat().forEach((x) => x && out.add(x));
    return [...out];
  },

  fromTmdb(ids) {
    return (ids || []).flatMap((id) => [TMDB_GENRES[id]].flat()).filter(Boolean);
  },
};

/* ------------------------------------------------------------- em alta */

const Trends = {
  raw: null,
  touched: [],

  get ready() {
    return this.touched.length > 0;
  },

  /** Busca as listas (cache de 12h no disco) e redesenha quando chegarem. */
  async load(onChange) {
    if (!Data.cfg.tmdbKey) return;
    // As ~120 listas juntas ficam guardadas por 12h: abrir o app nao repete as consultas.
    const saved = await native.cacheGet('trends').catch(() => null);
    if (saved?.lists && Date.now() - saved.at < TREND_TTL) {
      this.raw = saved;
      this.apply();
      onChange?.();
      return;
    }
    try {
      this.raw = await this.fetchAll();
      native.cacheSet('trends', { ...this.raw, at: Date.now() });
    } catch (err) {
      console.warn('Streamings: falhou', err);
      return;
    }
    this.apply();
    onChange?.();
  },

  async fetchAll() {
    const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const jobs = [];
    for (const p of PROVIDERS) {
      for (const type of ['movie', 'tv']) {
        const base = `/discover/${type}?watch_region=BR&with_watch_providers=${p.id}&with_watch_monetization_types=flatrate&language=pt-BR&sort_by=popularity.desc`;
        const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        const add = (list, pages, extra = '') => {
          for (let page = 1; page <= pages; page++) jobs.push({ type, prov: p.id, list, page, path: `${base}${extra}&page=${page}` });
        };
        add('pop', p.weight >= 1 ? 5 : 3);
        add('fresh', 2, `&${date}.gte=${day(-120)}&${date}.lte=${day(0)}`);
        // Series com episodio exibido nos ultimos dias.
        if (type === 'tv') add('air', 2, `&air_date.gte=${day(-10)}&air_date.lte=${day(1)}`);
      }
    }

    const lists = [];
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const d = await native.tmdb(job.path, TREND_TTL);
          const results = (d?.results || []).map((r) => ({
            id: r.id,
            title: r.title,
            name: r.name,
            original_title: r.original_title,
            original_name: r.original_name,
            release_date: r.release_date,
            first_air_date: r.first_air_date,
            genre_ids: r.genre_ids,
            backdrop_path: r.backdrop_path,
            poster_path: r.poster_path,
          }));
          lists.push({ ...job, path: undefined, results });
        } catch {
          failed++;
        }
      }
    };
    const logos = native.tmdb('/watch/providers/movie?watch_region=BR&language=pt-BR').catch(() => null);
    await Promise.all(Array.from({ length: 8 }, worker));
    if (!lists.length && failed) throw new Error('TMDB indisponível');

    for (const p of (await logos)?.results || []) if (Providers.byId.has(p.provider_id)) Providers.logos[p.provider_id] = p.logo_path;
    return { lists, logos: Providers.logos };
  },

  /** Cruza as listas com o catalogo atual (roda de novo sempre que o catalogo muda). */
  apply() {
    Memo.clear();
    for (const it of this.touched) delete it.trend;
    this.touched = [];
    if (!this.raw) return;
    Object.assign(Providers.logos, this.raw.logos);

    for (const e of this.raw.lists) {
      const kind = e.type === 'movie' ? 'movie' : 'series';
      const weight = Providers.byId.get(e.prov)?.weight || 0.3;
      e.results.forEach((r, i) => {
        const it = Data.findTmdb(kind, r);
        if (!it || it.adult) return;
        if (!it.trend) {
          it.trend = { score: 0, fresh: 0, air: 0, provs: [] };
          this.touched.push(it);
        }
        // Quanto mais no topo da lista do servico, mais pesa.
        const w = weight / (1 + ((e.page - 1) * 20 + i) / 15);
        const t = it.trend;
        t[e.list === 'pop' ? 'score' : e.list] += w;
        if (e.list !== 'pop') t.score += w / 2;
        if (!t.provs.includes(e.prov)) t.provs.push(e.prov);
        it.tmdb ||= String(r.id);
        if (!it.backdrop && r.backdrop_path) it.backdrop = tmdbImg(r.backdrop_path, 'w1280');
        if (!it.poster && r.poster_path) it.poster = tmdbImg(r.poster_path, 'w342');
        it.genres = [...new Set([...Genres.fromTmdb(r.genre_ids), ...it.genres])];
      });
    }
    for (const it of this.touched) it.prov = Providers.best(it.trend.provs) || it.prov;
  },

  /** Mais fortes primeiro; `field` e score (em alta), fresh (estreias) ou air (episodio novo). */
  top(kind, field = 'score', n = 40) {
    return Memo.get(`top:${kind}:${field}:${n}`, () =>
      this.touched
        .filter((x) => (!kind || x.kind === kind) && x.trend[field] > 0)
        .sort((a, b) => b.trend[field] - a.trend[field])
        .slice(0, n)
    );
  },
};
