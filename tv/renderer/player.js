/**
 * Player em tela cheia, pensado para mouse remoto: botoes grandes, barra de
 * progresso grossa e controles que somem sozinhos.
 *
 * Filmes e series sao MP4 (H.264 + AAC) e tocam direto no <video>. Ao vivo usa
 * HLS (.m3u8) via hls.js, porque o Chromium nao toca HLS nem MPEG-TS sozinho.
 */
const Player = {
  el: null,
  video: null,
  hls: null,
  session: null,
  hideTimer: null,
  saveTimer: 0,
  nextTimer: null,

  init() {
    this.el = $('#player');
    // Na TV o tizen/avplay-video.js troca o <video> pelo player nativo da Samsung.
    this.video = window.TvVideo || $('#video');
    const v = this.video;
    const q = (s) => this.el.querySelector(s);

    this.ui = {
      title: q('.p-title'),
      sub: q('.p-sub'),
      play: q('.p-play'),
      bigPlay: q('.p-bigplay'),
      bar: q('.p-bar'),
      fill: q('.p-fill'),
      buf: q('.p-buf'),
      hover: q('.p-hover'),
      time: q('.p-time'),
      next: q('.p-nextbtn'),
      channels: q('.p-chbtn'),
      side: q('.p-side'),
      nextCard: q('.p-nextcard'),
      error: q('.p-error'),
      spinner: q('.p-spinner'),
      vol: q('.p-vol'),
      seekRow: q('.p-seekrow'),
      scrub: q('.p-scrub'),
      thumb: q('.p-thumb'),
      scrubTime: q('.p-scrub-time'),
      cc: q('.p-cc'),
      ccMenu: q('.p-ccmenu'),
      subs: q('.p-subs'),
    };
    this.ui.cc.innerHTML = ICON.cc;
    this.ui.cc.onclick = () => (this.ccOpen ? this.closeCcMenu() : this.openCcMenu());

    q('.p-back').onclick = () => this.close();
    this.ui.play.onclick = () => this.toggle();
    this.ui.bigPlay.onclick = () => this.toggle();
    q('.p-rw').onclick = () => this.seekBy(-10);
    q('.p-ff').onclick = () => this.seekBy(30);
    q('.p-fs').onclick = () => native.toggleFullscreen();
    this.ui.volRange = q('.p-volrange');
    this.ui.vol.onclick = () => {
      // Mudo com a barra no zero: o clique devolve um volume audivel.
      if (v.muted || v.volume === 0) this.setVolume(v.volume || 0.5, false);
      else this.setVolume(v.volume, true);
    };
    this.ui.volRange.addEventListener('input', () => this.setVolume(this.ui.volRange.value / 100, false));
    this.ui.volRange.addEventListener('keydown', (e) => e.preventDefault());
    q('.p-volbox').addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setVolume(v.volume + (e.deltaY < 0 ? 0.05 : -0.05), false);
    });
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('player-volume'));
    } catch {}
    this.setVolume(saved?.volume ?? 1, !!saved?.muted, false);
    this.ui.next.onclick = () => this.playNext();
    this.ui.channels.onclick = () => this.ui.side.classList.toggle('open');

    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => native.toggleFullscreen());
    v.addEventListener('play', () => this.syncPlay());
    v.addEventListener('pause', () => this.syncPlay());
    v.addEventListener('waiting', () => this.ui.spinner.classList.add('on'));
    v.addEventListener('playing', () => this.ui.spinner.classList.remove('on'));
    v.addEventListener('canplay', () => this.ui.spinner.classList.remove('on'));
    v.addEventListener('timeupdate', () => this.onTime());
    v.addEventListener('progress', () => this.onBuffer());
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('error', () => this.onError());

    // Barra de progresso: clique para pular, passar o mouse mostra o tempo.
    const ratioAt = (e) => {
      const r = this.ui.bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    this.ui.bar.addEventListener('mousemove', (e) => {
      const ratio = ratioAt(e);
      this.ui.hover.style.left = `${ratio * 100}%`;
      this.ui.hover.textContent = fmtTime(ratio * (v.duration || 0));
    });
    this.ui.bar.addEventListener('click', (e) => {
      if (!isFinite(v.duration)) return;
      if (this.scrub) {
        this.scrub.target = ratioAt(e) * v.duration;
        return this.commitScrub();
      }
      v.currentTime = ratioAt(e) * v.duration;
    });

    this.el.addEventListener('mousemove', () => this.poke());
    this.el.addEventListener('wheel', (e) => {
      if (this.ui.side.contains(e.target)) return;
      this.poke();
    });
  },

  /** Volume de 0 a 1; fica guardado para a proxima vez que o app abrir. */
  setVolume(vol, muted, save = true) {
    const v = this.video;
    vol = Math.round(Math.min(1, Math.max(0, vol)) * 100) / 100;
    v.volume = vol;
    v.muted = muted;
    const shown = muted ? 0 : vol;
    this.ui.vol.innerHTML = shown === 0 ? ICON.mute : ICON.volume;
    this.ui.volRange.value = Math.round(shown * 100);
    this.ui.volRange.style.setProperty('--v', `${shown * 100}%`);
    if (!save) return;
    try {
      localStorage.setItem('player-volume', JSON.stringify({ volume: vol, muted }));
    } catch {}
    this.poke();
  },

  get open_() {
    return !this.el.hidden;
  },

  /**
   * opts: { kind: 'vod'|'live', title, sub, url, key, startAt, next, channels, onProgress }
   */
  open(opts) {
    this.stop();
    this.session = opts;
    const v = this.video;
    this.el.hidden = false;
    this.el.classList.toggle('is-live', opts.kind === 'live');
    document.body.classList.add('playing');
    this.ui.title.textContent = opts.title || '';
    this.ui.sub.textContent = opts.sub || '';
    this.ui.error.classList.remove('on');
    this.ui.nextCard.classList.remove('on');
    this.ui.next.hidden = !opts.next;
    this.ui.channels.hidden = !opts.channels;
    this.setupSubs(opts);
    this.helperStart(opts);
    this.ui.spinner.classList.add('on');
    this.ui.fill.style.width = '0';
    this.ui.buf.style.width = '0';
    this.renderChannels();

    if (opts.kind === 'live' && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: false, backBufferLength: 30 });
      let retried = false;
      let manifestTries = 0;
      const hls = this.hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // O provedor responde 404 por alguns segundos enquanto a conexao
        // anterior (outro canal, ou o filme que acabou) ainda nao fechou.
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR && manifestTries < 5) {
          manifestTries++;
          setTimeout(() => this.hls === hls && hls.loadSource(opts.url), 2500);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !retried) {
          retried = true;
          this.hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !retried) {
          retried = true;
          this.hls.recoverMediaError();
        } else if (opts.onFail) {
          // Canal com varias versoes: quem abriu tenta a proxima.
          opts.onFail();
        } else {
          this.showError('O canal não respondeu. Ele pode estar fora do ar agora.');
        }
      });
      this.hls.loadSource(opts.url);
      this.hls.attachMedia(v);
      this.loadEpg();
    } else {
      // Sem hls.js (TV): o player nativo toca o HLS sozinho. Quem abriu pode
      // trocar o endereco antes (ex.: achar um servidor do provedor que responde).
      if (opts.kind === 'live') this.loadEpg();
      if (opts.resolve) {
        opts.resolve(opts.url).then((url) => {
          if (this.session !== opts) return;
          v.src = url;
          v.play().catch(() => {});
        });
        this.poke();
        return;
      }
      v.src = opts.url;
      if (opts.startAt > 5) {
        v.addEventListener(
          'loadedmetadata',
          () => {
            v.currentTime = opts.startAt;
            toast(`Retomando de ${fmtTime(opts.startAt)}`);
          },
          { once: true }
        );
      }
    }
    v.play().catch(() => {});
    this.poke();
  },

  stop() {
    if (this.scrub) this.endScrub();
    clearInterval(this.helperTimer);
    this.helperCall('stop');
    this.closeCcMenu();
    this.saveNow();
    clearInterval(this.epgTimer);
    clearInterval(this.nextTimer);
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  },

  close() {
    if (!this.open_) return;
    this.stop();
    this.session?.onClose?.();
    this.session = null;
    this.el.hidden = true;
    this.ui.side.classList.remove('open');
    document.body.classList.remove('playing');
  },

  toggle() {
    if (this.scrub) return this.commitScrub();
    const v = this.video;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    this.poke();
  },

  /* ------------------------------------------- linha do tempo (pino) */

  /**
   * Como nos apps de streaming: cada clique so anda o pino na linha do tempo,
   * com o video pausado e uma miniatura da cena daquele ponto. O video so vai
   * para la no OK (ou no play); Voltar desiste e continua de onde estava.
   */
  scrub: null,
  preview: null,

  seekBy(sec) {
    const v = this.video;
    if (this.session?.kind === 'live' || !isFinite(v.duration)) return;
    const now = Date.now();
    let s = this.scrub;
    if (!s) {
      s = this.scrub = { target: v.currentTime, from: v.currentTime, wasPlaying: !v.paused, n: 0, last: 0, dir: 0 };
      v.pause();
      this.el.classList.add('scrubbing');
    }
    const dir = Math.sign(sec);
    s.n = dir === s.dir && now - s.last < 900 ? s.n + 1 : 0;
    s.dir = dir;
    s.last = now;
    // Clicando seguido (ou segurando), o pino anda cada vez mais rapido.
    const mult = s.n < 4 ? 1 : s.n < 10 ? 2 : s.n < 20 ? 4 : 8;
    s.target = Math.min(v.duration - 1, Math.max(0, s.target + sec * mult));
    this.renderScrub();
    this.poke();
  },

  renderScrub() {
    const s = this.scrub;
    const v = this.video;
    if (!s) return;
    const pct = s.target / v.duration;
    this.ui.fill.style.width = `${pct * 100}%`;
    this.ui.time.textContent = `${fmtTime(s.target)}  /  ${fmtTime(v.duration)}`;
    const diff = s.target - s.from;
    this.ui.scrubTime.textContent = `${fmtTime(s.target)}   ${diff >= 0 ? '+' : '−'}${fmtTime(Math.abs(diff))}`;
    // A miniatura acompanha o pino sem sair da tela nas pontas.
    const w = this.ui.bar.clientWidth;
    const half = this.ui.scrub.offsetWidth / 2;
    this.ui.scrub.style.left = `${Math.min(w - half, Math.max(half, pct * w))}px`;
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => this.showThumb(s), 200);
  },

  /**
   * A miniatura e um segundo video, so com a imagem, parado no ponto do pino.
   * Ele so existe enquanto o pino anda (usa a segunda conexao da lista).
   */
  showThumb(s) {
    if (this.scrub !== s || !this.session) return;
    // Na TV o segundo video disputa a unica camada de video com o AVPlay
    // (o filme ficava preto): la as fotos vem do ajudante no Mac (tv/helper).
    if (window.TvVideo) return this.helperThumb(s);
    let pv = this.preview;
    if (!pv) {
      pv = this.preview = h('video', { class: 'p-thumbv', preload: 'auto', playsinline: true });
      pv.muted = true;
      pv.addEventListener('seeked', () => {
        if (this.preview !== pv || !this.scrub) return;
        // A previa nao conseguiu ir ao ponto (servidor sem pulo): melhor sem miniatura do que com a cena errada.
        if (Math.abs(pv.currentTime - this.scrub.target) > 20) return this.ui.thumb.classList.add('off');
        this.ui.thumb.classList.add('ready');
      });
      pv.addEventListener('error', () => this.preview === pv && this.ui.thumb.classList.add('off'));
      this.ui.thumb.append(pv);
      pv.src = this.session.url;
    }
    this.ui.thumb.classList.remove('ready');
    const go = () => {
      if (this.scrub !== s || this.preview !== pv) return;
      const end = pv.seekable.length ? pv.seekable.end(pv.seekable.length - 1) : 0;
      if (end < s.target) return this.ui.thumb.classList.add('off');
      pv.currentTime = s.target;
    };
    if (pv.readyState >= 1) go();
    else pv.addEventListener('loadedmetadata', go, { once: true });
  },

  /* ------------------------------ miniaturas da TV (ajudante no Mac) */

  helperBase() {
    return (window.TvVideo && window.IPTV_DEFAULTS?.helper) || '';
  },

  helperCall(action, params = {}, session = this.session) {
    const base = this.helperBase();
    const r = session?.helperRef;
    if (!base || !r) return;
    fetch(`${base}/${action}?${new URLSearchParams({ kind: r.kind, id: r.id, ext: r.ext, ...params })}`).catch(() => {});
  },

  /** Avisa o ajudante onde o filme esta, para ele gerar as fotos dali para os lados. */
  helperStart(opts) {
    const m = /\/(movie|series)\/[^/]+\/[^/]+\/(\d+)\.(\w+)$/.exec(opts.url || '');
    if (!this.helperBase() || opts.kind === 'live' || !m) return;
    opts.helperRef = { kind: m[1], id: m[2], ext: m[3] };
    const v = this.video;
    const beat = () => this.session === opts && this.helperCall('watch', { at: Math.round(this.scrub?.target ?? v.currentTime ?? 0), dur: Math.round(v.duration) || 0 }, opts);
    beat();
    this.helperTimer = setInterval(beat, 15000);
    setTimeout(beat, 4000);
  },

  /** Foto do ponto do pino; enquanto o ajudante nao tem a exata, mostra a mais proxima e tenta de novo. */
  helperThumb(s) {
    const base = this.helperBase();
    const r = this.session?.helperRef;
    if (!base || !r) return this.ui.thumb.classList.add('off');
    let img = this.thumbImg;
    if (!img || !img.isConnected) {
      img = this.thumbImg = h('img', { class: 'p-thumbimg', alt: '' });
      this.ui.thumb.append(img);
    }
    const sec = Math.round(s.target);
    this.ui.thumb.classList.add('stale');
    clearTimeout(this.thumbRetry);
    const attempt = async (n) => {
      if (this.scrub !== s || Math.round(s.target) !== sec) return;
      let at = null;
      try {
        // A TV nao mostrava a foto vinda de blob: pergunta qual e a mais proxima e carrega pelo endereco.
        const res = await fetch(`${base}/near/${r.kind}/${r.id}/${sec}`);
        if (res.ok) {
          at = (await res.json()).at;
          const url = `${base}/frame/${r.kind}/${r.id}/${at}.jpg`;
          if (this.scrub !== s) return;
          if (img.dataset.at !== String(at)) {
            const loaded = await new Promise((done) => {
              const pre = new Image();
              pre.onload = () => done(pre.naturalWidth > 0);
              pre.onerror = () => done(false);
              pre.src = url;
            });
            if (this.scrub !== s) return;
            // Foto que nao abriu nao vai para a tela (nada de icone quebrado).
            if (!loaded) throw new Error('foto nao abriu');
            img.src = url;
            img.dataset.at = at;
          }
          this.ui.thumb.classList.add('ready');
          if (Math.abs(at - sec) <= 6) this.ui.thumb.classList.remove('stale');
        }
      } catch {}
      // Ainda longe do ponto: o ajudante ja esta gerando ali, pede de novo.
      if ((at == null || Math.abs(at - sec) > 6) && n < 12) this.thumbRetry = setTimeout(() => attempt(n + 1), 600);
    };
    attempt(0);
  },

  releasePreview() {
    clearTimeout(this.thumbRetry);
    this.ui.thumb.classList.remove('stale');
    const pv = this.preview;
    this.preview = null;
    this.ui.thumb.classList.remove('ready', 'off');
    if (!pv) return;
    pv.removeAttribute('src');
    pv.load();
    pv.remove();
  },

  endScrub() {
    clearTimeout(this.thumbTimer);
    this.scrub = null;
    this.el.classList.remove('scrubbing');
    this.releasePreview();
  },

  /** OK: o video vai para o ponto do pino e volta a tocar. */
  commitScrub() {
    const s = this.scrub;
    if (!s) return;
    this.endScrub();
    // O ajudante espera uns segundos: a TV precisa da conexao para pular.
    this.helperCall('watch', { at: Math.round(s.target), hold: 6 });
    this.video.currentTime = s.target;
    this.video.play().catch(() => {});
    this.onTime();
    this.poke();
  },

  /** Voltar: desiste e continua de onde estava. */
  cancelScrub() {
    const s = this.scrub;
    if (!s) return;
    this.endScrub();
    this.onTime();
    if (s.wasPlaying) this.video.play().catch(() => {});
    this.poke();
  },

  /** Voltar/Esc: fecha o que estiver aberto por cima do video. Diz se fechou algo. */
  backOverlay() {
    if (this.scrub) return this.cancelScrub(), true;
    if (this.ccOpen) return this.closeCcMenu(), true;
    if (this.ccFocus) return this.setCcFocus(false), true;
    return false;
  },

  /* ------------------------------------------------------------ legendas */

  subList: null,
  subCur: null,
  cues: null,
  ccOpen: false,
  ccFocus: false,

  setupSubs(opts) {
    this.subList = null;
    this.subCur = null;
    this.cues = null;
    this.lastCue = null;
    this.ui.subs.textContent = '';
    this.setCcFocus(false);
    const can = opts.kind !== 'live' && !!opts.subs;
    this.ui.cc.hidden = !can;
    this.ui.cc.classList.remove('on');
    if (!can) return;
    Subs.find(opts.subs).then((list) => {
      if (this.session !== opts) return;
      this.subList = list;
      if (this.ccOpen) this.renderCcMenu();
      // Ja tinha escolhido um idioma antes: entra nele sozinho.
      const pick = Subs.pref && list.find((x) => x.lang === Subs.pref);
      if (pick && !this.subCur) this.chooseSub(pick, true);
    });
  },

  async chooseSub(sub, auto) {
    this.subCur = sub;
    this.cues = null;
    this.lastCue = null;
    this.ui.subs.textContent = '';
    this.ui.cc.classList.toggle('on', !!sub);
    if (this.ccOpen) this.renderCcMenu();
    if (!auto) {
      Subs.pref = sub ? sub.lang : '';
      store.set('subs-lang', Subs.pref);
    }
    if (!sub) return;
    try {
      const cues = await Subs.load(sub);
      if (this.subCur !== sub) return;
      this.cues = cues;
      this.renderSubs();
      if (!auto) toast(`Legenda: ${sub.langLabel}`);
    } catch {
      if (this.subCur !== sub) return;
      toast('Não consegui baixar essa legenda. Tente outra opção.');
      this.subCur = null;
      this.ui.cc.classList.remove('on');
    }
  },

  renderSubs() {
    if (!this.cues) return;
    const cue = Subs.at(this.cues, this.video.currentTime);
    if (cue === this.lastCue) return;
    this.lastCue = cue;
    this.ui.subs.replaceChildren(...(cue ? [h('span', {}, cue.text)] : []));
  },

  openCcMenu() {
    if (this.ui.cc.hidden) return;
    this.ccOpen = true;
    this.ccSel = null;
    this.renderCcMenu();
    this.ui.ccMenu.classList.add('on');
    this.poke();
  },

  closeCcMenu() {
    this.ccOpen = false;
    this.ui.ccMenu?.classList.remove('on');
  },

  renderCcMenu() {
    const list = this.subList;
    const rows = [{ sub: null, title: 'Desligada' }];
    for (const sub of list || []) {
      const n = list.filter((x) => x.lang === sub.lang).indexOf(sub) + 1;
      rows.push({ sub, title: `${sub.langLabel}${n > 1 ? ` · opção ${n}` : ''}${sub.hi ? ' · para surdos' : ''}`, detail: sub.release });
    }
    const items = rows.map((r) =>
      h(
        'button',
        { class: `p-cc-item${r.sub === this.subCur ? ' cur' : ''}`, onclick: () => (this.chooseSub(r.sub), this.closeCcMenu()) },
        h('span', { class: 'p-cc-check' }, r.sub === this.subCur ? '✓' : ''),
        h('span', { class: 'p-cc-text' }, h('b', {}, r.title), r.detail ? h('small', {}, r.detail) : null)
      )
    );
    const status = !list ? 'Procurando legendas…' : list.length ? '' : 'Nenhuma legenda em português ou inglês para este título.';
    this.ui.ccMenu.replaceChildren(h('div', { class: 'p-cc-head' }, 'Legendas'), ...items, ...(status ? [h('div', { class: 'p-cc-status' }, status)] : []));
    if (this.ccSel == null) this.ccSel = Math.max(0, rows.findIndex((r) => r.sub === this.subCur));
    this.moveCc(0);
  },

  moveCc(d) {
    const items = [...this.ui.ccMenu.querySelectorAll('.p-cc-item')];
    if (!items.length) return;
    this.ccSel = Math.max(0, Math.min(items.length - 1, (this.ccSel || 0) + d));
    items.forEach((el, i) => el.classList.toggle('sel', i === this.ccSel));
    items[this.ccSel].scrollIntoView({ block: 'nearest' });
  },

  /** No controle da TV: seta para baixo leva ao botao de legenda. */
  setCcFocus(on) {
    this.ccFocus = on;
    this.ui.cc?.classList.toggle('tv-focus', on);
    if (on) this.poke();
  },

  /** Teclas do controle com legenda/pino em jogo. Devolve true se usou a tecla. */
  tvKey(key) {
    if (this.ccOpen) {
      if (key === 'up' || key === 'down') this.moveCc(key === 'up' ? -1 : 1);
      else if (key === 'ok') this.ui.ccMenu.querySelectorAll('.p-cc-item')[this.ccSel]?.click();
      this.poke();
      return true;
    }
    if (this.scrub) {
      if (key === 'ok') this.commitScrub();
      else if (key === 'left' || key === 'right') return false;
      return true;
    }
    if (this.ccFocus) {
      if (key === 'ok') this.openCcMenu();
      else if (key === 'up') this.setCcFocus(false);
      else if (key === 'left' || key === 'right') {
        this.setCcFocus(false);
        return false;
      }
      this.poke();
      return true;
    }
    if (key === 'down' && this.session?.kind !== 'live' && !this.ui.cc.hidden) {
      this.setCcFocus(true);
      return true;
    }
    return false;
  },

  syncPlay() {
    const paused = this.video.paused;
    this.ui.play.innerHTML = paused ? ICON.play : ICON.pause;
    this.ui.bigPlay.innerHTML = paused ? ICON.play : ICON.pause;
    this.el.classList.toggle('paused', paused);
    this.poke();
  },

  /** Mostra os controles e agenda o sumico (so enquanto o video toca). */
  poke() {
    this.el.classList.add('ui-on');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && !this.ui.side.classList.contains('open') && !this.ccOpen && !this.ccFocus) this.el.classList.remove('ui-on');
    }, 3200);
  },

  onTime() {
    const v = this.video;
    this.renderSubs();
    // Pino andando: a barra mostra o ponto escolhido, nao o do video.
    if (this.scrub) return;
    // No ao vivo o HLS informa a duracao da janela de segmentos, nao do programa.
    if (this.session?.kind === 'live' || !isFinite(v.duration) || !v.duration) {
      this.ui.time.textContent = this.session?.kind === 'live' ? 'AO VIVO' : fmtTime(v.currentTime);
      return;
    }
    this.ui.fill.style.width = `${(v.currentTime / v.duration) * 100}%`;
    this.ui.time.textContent = `${fmtTime(v.currentTime)}  /  ${fmtTime(v.duration)}`;

    if (Date.now() - this.saveTimer > 5000) this.saveNow();

    // Faltando 25s, oferece o proximo episodio.
    const s = this.session;
    if (s?.next && v.duration - v.currentTime < 25 && !this.ui.nextCard.classList.contains('on') && !s.nextDismissed) this.offerNext();
  },

  onBuffer() {
    const v = this.video;
    if (!v.buffered.length || !isFinite(v.duration)) return;
    this.ui.buf.style.width = `${(v.buffered.end(v.buffered.length - 1) / v.duration) * 100}%`;
  },

  saveNow() {
    const s = this.session;
    const v = this.video;
    if (!s?.key || s.kind === 'live' || !isFinite(v.duration) || !v.currentTime) return;
    this.saveTimer = Date.now();
    Watch.save(s.key, v.currentTime, v.duration);
    s.onProgress?.(v.currentTime / v.duration);
  },

  onEnded() {
    this.saveNow();
    if (this.session?.next) this.playNext();
    else this.close();
  },

  offerNext() {
    const card = this.ui.nextCard;
    const s = this.session;
    let left = 10;
    card.querySelector('.p-nc-title').textContent = s.next.label;
    const count = card.querySelector('.p-nc-count');
    count.textContent = left;
    card.classList.add('on');
    card.querySelector('.p-nc-go').onclick = () => this.playNext();
    card.querySelector('.p-nc-cancel').onclick = () => {
      s.nextDismissed = true;
      clearInterval(this.nextTimer);
      card.classList.remove('on');
    };
    clearInterval(this.nextTimer);
    this.nextTimer = setInterval(() => {
      left--;
      count.textContent = left;
      if (left <= 0) this.playNext();
    }, 1000);
  },

  playNext() {
    const next = this.session?.next;
    clearInterval(this.nextTimer);
    if (!next) return;
    this.saveNow();
    next.play();
  },

  onError() {
    if (this.session?.kind === 'live' && this.hls) return;
    // Ao vivo sem hls.js: o provedor recusa por alguns segundos enquanto a conexao anterior fecha.
    const s = this.session;
    if (s?.kind === 'live' && (s.tries || 0) < 4) {
      s.tries = (s.tries || 0) + 1;
      setTimeout(() => {
        if (this.session !== s) return;
        this.video.src = s.url;
        this.video.play().catch(() => {});
      }, 2500);
      return;
    }
    const err = this.video.error;
    if (!err || !this.session) return;
    const msg =
      err.code === 4
        ? 'Este arquivo está num formato que o app não consegue tocar.'
        : 'Não foi possível carregar o vídeo. Verifique a internet ou tente de novo.';
    this.showError(msg);
  },

  showError(msg) {
    this.ui.spinner.classList.remove('on');
    const box = this.ui.error;
    box.querySelector('.p-err-msg').textContent = msg;
    box.querySelector('.p-err-retry').onclick = () => this.open(this.session);
    box.querySelector('.p-err-close').onclick = () => this.close();
    box.classList.add('on');
  },

  /* ------------------------------------------------------------- ao vivo */

  async loadEpg() {
    const s = this.session;
    const show = async () => {
      if (this.session !== s) return;
      const list = await Data.shortEpg(s.streamId);
      if (this.session !== s) return;
      const now = Date.now();
      const cur = list.find((e) => e.start <= now && e.end > now) || list[0];
      const nxt = list.find((e) => e.start > now);
      const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const parts = [];
      if (cur?.title) parts.push(`Agora: ${cur.title} (${hm(cur.start)}–${hm(cur.end)})`);
      if (nxt?.title) parts.push(`A seguir: ${nxt.title} às ${hm(nxt.start)}`);
      this.ui.sub.textContent = parts.join('   ·   ') || s.sub || '';
    };
    show();
    this.epgTimer = setInterval(show, 60000);
  },

  renderChannels() {
    const s = this.session;
    const side = this.ui.side;
    side.innerHTML = '';
    if (!s?.channels) return;
    const list = h('div', { class: 'p-side-list' });
    for (const ch of s.channels) {
      const row = h(
        'button',
        { class: 'p-ch' + (ch.key === (s.chKey || s.key) ? ' on' : ''), onclick: () => App.playLive(ch, s.channels) },
        h('img', { src: ch.poster, loading: 'lazy', onerror: (e) => (e.target.style.visibility = 'hidden') }),
        h('span', {}, ch.num ? `${ch.num}  ${ch.name}` : ch.name)
      );
      list.append(row);
    }
    side.append(h('div', { class: 'p-side-head' }, 'Canais'), list);
    requestAnimationFrame(() => side.querySelector('.p-ch.on')?.scrollIntoView({ block: 'center' }));
  },

  switchChannel(step) {
    const s = this.session;
    if (!s?.channels) return;
    const i = s.channels.findIndex((c) => c.key === (s.chKey || s.key));
    const next = s.channels[(i + step + s.channels.length) % s.channels.length];
    App.playLive(next, s.channels);
  },

  onKey(e) {
    const v = this.video;
    const tvMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok' };
    // TV: a seta para baixo vai ao botao de legenda. Menu de legenda e pino respondem antes de tudo.
    if ((document.body.classList.contains('tv') || this.ccOpen || this.scrub) && tvMap[e.key] && this.tvKey(tvMap[e.key])) {
      e.preventDefault();
      this.poke();
      return;
    }
    switch (e.key) {
      case 'c':
        this.ui.cc.click();
        break;
      case ' ':
      case 'k':
      case 'Enter':
        this.toggle();
        break;
      case 'ArrowLeft':
        this.seekBy(-10);
        break;
      case 'ArrowRight':
        this.seekBy(30);
        break;
      case 'ArrowUp':
        if (this.session?.channels) this.switchChannel(-1);
        else this.setVolume(v.volume + 0.1, false);
        break;
      case 'ArrowDown':
        if (this.session?.channels) this.switchChannel(1);
        else this.setVolume(v.volume - 0.1, false);
        break;
      case '+':
      case '=':
        this.setVolume(v.volume + 0.1, false);
        break;
      case '-':
        this.setVolume(v.volume - 0.1, false);
        break;
      case 'm':
        this.ui.vol.click();
        break;
      case 'f':
        native.toggleFullscreen();
        break;
      case 'Escape':
      case 'Backspace':
        if (this.backOverlay()) break;
        if (this.ui.side.classList.contains('open')) this.ui.side.classList.remove('open');
        else this.close();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.poke();
  },
};
