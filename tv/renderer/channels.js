/**
 * Canais ao vivo no Mac, do mesmo jeito da TV: "HBO HD" e "HBO FHD" viram um
 * canal so ("HBO"). Ao abrir, o app escolhe sozinho a versao que abre mais
 * rapido (e aprende com o uso); se uma falhar ou demorar, passa para a proxima.
 *
 * Na TV o tizen/live.js faz isso com a tela dele; la este arquivo nao e usado.
 */
const Channels = {
  QUALITY: /\b(fhd|full\s*hd|uhd|4k|hd|sd|h\.?265|hevc)\b/gi,
  list: [],
  builtFrom: null,
  byVariant: new Map(),
  stats: store.get('live-stats', {}),
  cur: null,

  /** Lista unica, na ordem da sua lista; cada canal fica na pasta da primeira versao. */
  build() {
    if (this.builtFrom === Data.items.live) return this.list;
    this.builtFrom = Data.items.live;
    const byBase = new Map();
    const list = [];
    for (const cat of Data.cats.live) {
      for (const it of cat.items) {
        const base = this.baseKey(it.name);
        let ch = byBase.get(base);
        if (!ch) {
          ch = { kind: 'live', key: `ch:${base}`, name: this.baseName(it.name), poster: '', cat: it.cat, variants: [] };
          byBase.set(base, ch);
          list.push(ch);
        }
        ch.variants.push(it);
        ch.poster ||= it.poster;
      }
    }
    list.forEach((ch, i) => (ch.num = i + 1));
    this.byVariant = new Map(list.flatMap((ch) => ch.variants.map((v) => [v.key, ch])));
    return (this.list = list);
  },

  baseKey(name) {
    const s = String(name || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\+/g, ' plus ')
      .replace(this.QUALITY, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b0+(\d)/g, '$1')
      .trim();
    return s || String(name);
  },

  baseName(name) {
    return String(name).replace(this.QUALITY, ' ').replace(/\s*-\s*$/, '').replace(/\s+-\s+(?=\d)/, ' ').replace(/\s+/g, ' ').trim() || name;
  },

  /** Canal de um item (versao) ou do proprio canal. */
  find(item) {
    if (!item) return null;
    if (item.variants) return item;
    this.build();
    return this.byVariant.get(item.key) || this.list.find((c) => c.key === item.key) || null;
  },

  /** Canais do historico, sem repetir o mesmo canal por versoes diferentes. */
  recent() {
    const keys = Watch.history.map((x) => x.key);
    return [...new Set(keys.map((k) => this.find(Data.byKey.get(k) || { key: k })).filter(Boolean))];
  },

  /** Canais cuja primeira versao esta nesta pasta. */
  inCat(cat) {
    return this.build().filter((ch) => ch.cat === cat.id);
  },

  /* ------------------------------------------- escolha da melhor versao */

  quality(v) {
    const n = v.name;
    if (/\b(uhd|4k)\b/i.test(n)) return 2.5; // pesado demais para a rede de casa
    if (/\bsd\b/i.test(n)) return 1.2; // abre rapido, mas imagem fraca
    if (/\b(fhd|full\s*hd)\b/i.test(n)) return 0.4;
    if (/\bhd\b/i.test(n)) return 0;
    return 0.3;
  },

  /** Nota de cada versao: tempo medio para abrir + falhas recentes + peso da qualidade. Menor e melhor. */
  score(v) {
    const st = this.stats[v.id] || {};
    return (st.n ? st.avg : 3) + (st.fails || 0) * 4 + this.quality(v);
  },

  ranked(ch) {
    return ch.variants.slice().sort((a, b) => this.score(a) - this.score(b));
  },

  record(v, ok, seconds) {
    const st = (this.stats[v.id] ||= { n: 0, avg: 0, fails: 0 });
    if (ok) {
      st.avg = st.n ? st.avg * 0.7 + seconds * 0.3 : seconds;
      st.n++;
      st.fails = Math.max(0, st.fails - 0.5);
    } else st.fails = Math.min(5, st.fails + 1);
    store.set('live-stats', this.stats);
  },

  /* ------------------------------------------------------------ tocar */

  play(item) {
    const ch = this.find(item);
    if (!ch) return;
    if (this.cur) clearTimeout(this.cur.timer);
    this.cur = { ch, order: this.ranked(ch), i: 0, cycle: 0 };
    Watch.touch(ch.variants[0]);
    this.openVariant();
  },

  openVariant() {
    const c = this.cur;
    const v = c.order[c.i];
    clearTimeout(c.timer);
    c.ok = false;
    c.t0 = Date.now();
    Player.open({
      kind: 'live',
      title: `${c.ch.num}   ${c.ch.name}`,
      sub: Data.catName(v),
      url: Data.streamUrl('live', v.id, 'm3u8'),
      key: v.key,
      chKey: c.ch.key,
      streamId: v.id,
      channels: this.build(),
      onFail: () => this.cur === c && this.fail(),
      onClose: () => {
        if (this.cur === c) {
          clearTimeout(c.timer);
          this.cur = null;
        }
      },
    });
    // Demorou demais para abrir: tenta a proxima versao.
    c.timer = setTimeout(() => this.cur === c && !c.ok && this.fail(), 9000);
  },

  started() {
    const c = this.cur;
    if (!c || c.ok || Player.session?.key !== c.order[c.i].key) return;
    c.ok = true;
    clearTimeout(c.timer);
    this.record(c.order[c.i], true, (Date.now() - c.t0) / 1000);
  },

  fail() {
    const c = this.cur;
    if (!c) return;
    clearTimeout(c.timer);
    // Ja estava tocando e caiu: tenta de novo a mesma lista, comecando pela melhor.
    if (!c.ok) this.record(c.order[c.i], false);
    c.i++;
    if (c.i < c.order.length) return this.openVariant();
    // Todas falharam: o provedor costuma recusar por alguns segundos depois de uma troca.
    if (c.cycle++ < 1) {
      c.i = 0;
      return setTimeout(() => this.cur === c && this.openVariant(), 2500);
    }
    Player.showError('O canal não respondeu. Ele pode estar fora do ar agora.');
    Player.ui.error.querySelector('.p-err-retry').onclick = () => this.play(c.ch);
  },

  init() {
    Player.video.addEventListener('playing', () => this.started());
    Player.video.addEventListener('timeupdate', () => Player.video.currentTime > 0 && this.started());
  },
};
