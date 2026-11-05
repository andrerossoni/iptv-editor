/**
 * Legendas da base publica do OpenSubtitles (sem chave), sempre em portugues
 * do Brasil e ingles. A busca comeca quando o filme e aberto; no player, o
 * botao de legenda mostra as opcoes encontradas.
 *
 * Com a chave do TMDB a busca vai pelo codigo do IMDb (acerta o filme exato);
 * sem ela, pelo nome e ano.
 */
const Subs = {
  API: 'https://rest.opensubtitles.org/search',
  LANGS: [
    { code: 'pob', label: 'Português (BR)' },
    { code: 'eng', label: 'English (US)' },
  ],
  PER_LANG: 4,
  found: new Map(),
  /** Ultimo idioma escolhido: a proxima legenda ja entra nele. */
  pref: store.get('subs-lang', ''),

  async imdb(kind, tmdbId) {
    if (!tmdbId) return '';
    try {
      const d = await native.tmdb(`/${kind === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids`, 30 * 86400000);
      return (d?.imdb_id || '').replace(/^tt/, '');
    } catch {
      return '';
    }
  },

  /** ctx: { key, kind: 'movie'|'series', tmdb, name, year, season?, episode? } */
  find(ctx) {
    if (!ctx?.key) return Promise.resolve([]);
    if (!this.found.has(ctx.key)) {
      const p = this.search(ctx).catch((err) => {
        console.warn('Legendas:', err);
        return [];
      });
      this.found.set(ctx.key, p);
      // Nada encontrado (ou sem internet): deixa tentar de novo mais tarde.
      p.then((list) => !list.length && setTimeout(() => this.found.get(ctx.key) === p && this.found.delete(ctx.key), 60000));
    }
    return this.found.get(ctx.key);
  },

  async search(ctx) {
    const imdb = await this.imdb(ctx.kind, ctx.tmdb);
    const isEp = ctx.season != null && ctx.episode != null;
    const name = String(ctx.name || '')
      .replace(/\(\d{4}\)|\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!imdb && !name) return [];
    const who = imdb ? `imdbid-${imdb}` : `query-${encodeURIComponent(name)}`;
    const path = isEp ? `/episode-${ctx.episode}/${who}/season-${ctx.season}` : `/${who}`;

    const perLang = await Promise.all(
      this.LANGS.map(async (lang) => {
        const res = await fetch(`${this.API}${path}/sublanguageid-${lang.code}`);
        if (!res.ok) return [];
        let list = await res.json();
        if (!Array.isArray(list)) return [];
        list = list.filter((s) => s.SubFormat === 'srt' && s.SubBad !== '1' && s.SubDownloadLink);
        if (isEp) list = list.filter((s) => +s.SeriesSeason === +ctx.season && +s.SeriesEpisode === +ctx.episode);
        else if (!imdb && ctx.year) list = list.filter((s) => !+s.MovieYear || Math.abs(+s.MovieYear - ctx.year) <= 1);
        list.sort((a, b) => (+b.SubDownloadsCnt || 0) - (+a.SubDownloadsCnt || 0));
        const seen = new Set();
        const out = [];
        for (const s of list) {
          if (seen.has(s.SubHash)) continue;
          seen.add(s.SubHash);
          out.push({
            id: s.IDSubtitleFile,
            lang: lang.code,
            langLabel: lang.label,
            release: String(s.MovieReleaseName || s.SubFileName || '').replace(/\.(srt|mkv|mp4|avi)$/i, '').trim(),
            hi: s.SubHearingImpaired === '1',
            url: s.SubDownloadLink,
            enc: s.SubEncoding || 'UTF-8',
          });
          if (out.length >= this.PER_LANG) break;
        }
        return out;
      })
    );
    return perLang.flat();
  },

  /** Baixa e le a legenda: lista de { s, e, text } em segundos, em ordem. */
  async load(sub) {
    if (sub.cues) return sub.cues;
    const res = await fetch(sub.url);
    if (!res.ok) throw new Error(`legenda ${res.status}`);
    const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const enc = /^utf-?8$/i.test(sub.enc) ? 'utf-8' : sub.enc.replace(/^CP(\d+)$/i, 'windows-$1').toLowerCase();
    let text;
    try {
      text = new TextDecoder(enc).decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }
    return (sub.cues = this.parse(text));
  },

  parse(text) {
    const time = (t) => {
      const m = t.match(/(\d+):(\d\d):(\d\d)[,.](\d+)/);
      return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : NaN;
    };
    // Propaganda que a base coloca no comeco e no fim do arquivo.
    const ad = /https?:|www\.|opensubtitles|osdb\.|tryray|\.(com|app|org|net)\b/i;
    const cues = [];
    for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.trim().split('\n');
      const at = lines.findIndex((l) => l.includes('-->'));
      if (at < 0) continue;
      const [a, b] = lines[at].split('-->');
      const s = time(a);
      const e = time(b);
      const body = lines
        .slice(at + 1)
        .join('\n')
        .replace(/<[^>]+>|\{\\[^}]*\}/g, '')
        .trim();
      if (!body || !(e > s) || ad.test(body)) continue;
      cues.push({ s, e, text: body });
    }
    return cues.sort((x, y) => x.s - y.s);
  },

  /** Fala que aparece no segundo t (ou null). */
  at(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].e <= t) lo = mid + 1;
      else if (cues[mid].s > t) hi = mid - 1;
      else return cues[mid];
    }
    return null;
  },
};
