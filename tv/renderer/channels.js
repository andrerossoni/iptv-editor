/**
 * Canais ao vivo no Mac, do mesmo jeito da TV: "HBO HD" e "HBO FHD" viram um
 * canal so ("HBO"). Ao abrir, o app escolhe sozinho a versao que abre mais
 * rapido (e aprende com o uso); se uma falhar ou demorar, passa para a proxima.
 *
 * Abre na versao que abre mais rapido e, se houver uma com imagem melhor,
 * carrega essa por tras e troca com uma piscada (como os apps de TV ao vivo).
 *
 * Na TV o tizen/live.js toca os canais com a tela dele; de la ele usa daqui
 * so as regras de qualidade (level, best) e a limpeza (cleanup).
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

  /** Nivel da imagem: 1 SD, 2 HD (ou sem marca), 3 FHD, 4 4K. */
  level(v) {
    const n = v.name;
    if (/\b(uhd|4k)\b/i.test(n)) return 4;
    if (/\b(fhd|full\s*hd)\b/i.test(n)) return 3;
    if (/\bsd\b/i.test(n)) return 1;
    return 2;
  },

  /**
   * Versao com a melhor imagem que costuma funcionar (sem 4K: pesado demais
   * para a rede de casa). O canal abre na mais rapida e depois passa para esta.
   */
  best(ch, stats = this.stats) {
    const ok = ch.variants.filter((v) => this.level(v) <= 3 && (stats[v.id]?.fails || 0) < 3);
    return ok.sort((a, b) => this.level(b) - this.level(a) || (stats[a.id]?.avg || 3) - (stats[b.id]?.avg || 3))[0] || null;
  },

  /**
   * O servidor tirou ou trocou canais: apaga as anotacoes de versoes que
   * sumiram, e o historico de um canal que voltou com outro codigo (mesmo
   * nome) passa para o novo. O que sumiu de vez sai do historico.
   */
  cleanup() {
    const live = Data.items.live || [];
    if (live.length < 20) return; // lista incompleta: melhor nao mexer
    const ids = new Set(live.map((v) => String(v.id)));
    const prune = (stats) => Object.keys(stats).filter((id) => !ids.has(String(id))).forEach((id) => delete stats[id]);
    prune(this.stats);
    const tv = typeof Live !== 'undefined' ? Live : null;
    if (tv) prune(tv.stats);
    store.set('live-stats', tv ? tv.stats : this.stats);

    this.build();
    const byBase = new Map(this.list.map((ch) => [this.baseKey(ch.name), ch]));
    let changed = false;
    const seen = new Set();
    const hist = [];
    for (const h of Watch.history) {
      let x = h;
      if (String(h.key).startsWith('live:')) {
        const item = Data.byKey.get(h.key);
        if (item) {
          if (!h.name) x = { ...h, name: item.name };
        } else {
          const ch = h.name && byBase.get(this.baseKey(h.name));
          Watch.gone[h.key] = Math.max(Watch.gone[h.key] || 0, h.t);
          x = ch ? { ...h, key: ch.variants[0].key } : null;
        }
        if (x !== h) changed = true;
      }
      if (x && !seen.has(x.key)) {
        seen.add(x.key);
        hist.push(x);
      } else if (x) changed = true;
    }
    if (!changed) return;
    Watch.history = hist;
    store.set('history', hist);
    store.set('history-gone', Watch.gone);
    Sync.soon();
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
    if (this.cur) this.drop(this.cur);
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
          this.drop(c);
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
    // Abriu numa versao mais leve: carrega a melhor por tras e troca.
    const b = this.best(c.ch);
    if (!c.upgraded && b && this.level(b) > this.level(c.order[c.i]) && window.Hls) {
      c.upgraded = true;
      c.up = setTimeout(() => this.cur === c && this.upgrade(c, b), 2000);
    }
  },

  /** Para tudo que o canal deixou rodando (timers e o video de tras). */
  drop(c) {
    clearTimeout(c.timer);
    clearTimeout(c.up);
    c.shadowDone?.();
  },

  /**
   * Troca para a versao melhor sem tela preta: um video escondido (sem som)
   * carrega a versao melhor; quando ele ja esta tocando, cobre a tela, o player
   * reabre nessa versao por baixo e a capa sai quando ele volta a tocar. Na
   * tela aparece so uma piscada. Nunca passa de 2 conexoes com o provedor.
   */
  upgrade(c, b) {
    const shadow = document.createElement('video');
    shadow.className = 'p-shadow';
    shadow.muted = true;
    shadow.playsInline = true;
    Player.video.after(shadow);
    const hls = new Hls({ lowLatencyMode: false, backBufferLength: 10 });
    let giveUp = 0;
    const done = () => {
      clearTimeout(giveUp);
      c.shadowDone = null;
      hls.destroy();
      shadow.remove();
    };
    c.shadowDone = done;
    // A melhor nao abriu: fica na que esta, sem avisar.
    giveUp = setTimeout(() => {
      this.record(b, false);
      done();
    }, 15000);
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || !c.shadowDone) return;
      this.record(b, false);
      done();
    });
    hls.loadSource(Data.streamUrl('live', b.id, 'm3u8'));
    hls.attachMedia(shadow);
    shadow.play().catch(() => {});
    shadow.addEventListener(
      'playing',
      () => {
        if (this.cur !== c || c.shadowDone !== done) return done();
        clearTimeout(giveUp);
        shadow.volume = Player.video.volume;
        shadow.muted = Player.video.muted;
        shadow.classList.add('on');
        c.i = c.order.indexOf(b);
        this.openVariant();
        const main = Player.video;
        const off = () => {
          if (main.currentTime <= 0) return;
          main.removeEventListener('timeupdate', off);
          done();
        };
        main.addEventListener('timeupdate', off);
        // Se o player demorar, tira a capa assim mesmo.
        giveUp = setTimeout(() => {
          main.removeEventListener('timeupdate', off);
          done();
        }, 12000);
      },
      { once: true }
    );
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
