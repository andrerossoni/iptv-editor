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
    };

    q('.p-back').onclick = () => this.close();
    this.ui.play.onclick = () => this.toggle();
    this.ui.bigPlay.onclick = () => this.toggle();
    q('.p-rw').onclick = () => this.seekBy(-10);
    q('.p-ff').onclick = () => this.seekBy(30);
    q('.p-fs').onclick = () => native.toggleFullscreen();
    this.ui.vol.onclick = () => {
      v.muted = !v.muted;
      this.ui.vol.innerHTML = v.muted ? ICON.mute : ICON.volume;
    };
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
      if (isFinite(v.duration)) v.currentTime = ratioAt(e) * v.duration;
    });

    this.el.addEventListener('mousemove', () => this.poke());
    this.el.addEventListener('wheel', (e) => {
      if (this.ui.side.contains(e.target)) return;
      this.poke();
    });
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
        } else {
          this.showError('O canal não respondeu. Ele pode estar fora do ar agora.');
        }
      });
      this.hls.loadSource(opts.url);
      this.hls.attachMedia(v);
      this.loadEpg();
    } else {
      // Sem hls.js (TV): o player nativo toca o HLS sozinho.
      if (opts.kind === 'live') this.loadEpg();
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
    const v = this.video;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    this.poke();
  },

  seekBy(sec) {
    const v = this.video;
    if (this.session?.kind === 'live' || !isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration - 1, Math.max(0, v.currentTime + sec));
    this.poke();
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
      if (!this.video.paused && !this.ui.side.classList.contains('open')) this.el.classList.remove('ui-on');
    }, 3200);
  },

  onTime() {
    const v = this.video;
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
        { class: 'p-ch' + (ch.key === s.key ? ' on' : ''), onclick: () => App.playLive(ch, s.channels) },
        h('img', { src: ch.poster, loading: 'lazy', onerror: (e) => (e.target.style.visibility = 'hidden') }),
        h('span', {}, ch.name)
      );
      list.append(row);
    }
    side.append(h('div', { class: 'p-side-head' }, 'Canais'), list);
    requestAnimationFrame(() => side.querySelector('.p-ch.on')?.scrollIntoView({ block: 'center' }));
  },

  switchChannel(step) {
    const s = this.session;
    if (!s?.channels) return;
    const i = s.channels.findIndex((c) => c.key === s.key);
    const next = s.channels[(i + step + s.channels.length) % s.channels.length];
    App.playLive(next, s.channels);
  },

  onKey(e) {
    const v = this.video;
    switch (e.key) {
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
        else v.volume = Math.min(1, v.volume + 0.1);
        break;
      case 'ArrowDown':
        if (this.session?.channels) this.switchChannel(1);
        else v.volume = Math.max(0, v.volume - 0.1);
        break;
      case 'f':
        native.toggleFullscreen();
        break;
      case 'Escape':
      case 'Backspace':
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
