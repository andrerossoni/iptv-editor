/**
 * O <video> do navegador da TV recusa os arquivos do provedor ("formato nao
 * suportado"). O player nativo da Samsung (AVPlay) toca MP4, MKV, TS e HLS,
 * entao este arquivo imita o pedaco do <video> que o player.js usa — src,
 * play/pause, currentTime, duration e os eventos — por cima do AVPlay.
 *
 * O AVPlay desenha num plano abaixo da pagina: enquanto o video toca, a
 * pagina fica transparente (ver tv.css) e so os controles aparecem por cima.
 */
(function () {
  if (!window.webapis || !webapis.avplay) return;
  const av = webapis.avplay;

  const object = document.createElement('object');
  object.type = 'application/avplayer';
  object.id = 'avplayer';
  document.getElementById('player').prepend(object);
  document.getElementById('video').remove();

  const listeners = {};
  const emit = (type) => (listeners[type] || []).slice().forEach((l) => {
    if (l.once) listeners[type] = listeners[type].filter((x) => x !== l);
    l.fn();
  });

  let url = '';
  let prepared = false;
  let wantPlay = false;
  let pendingSeek = null;
  let now = 0;
  let session = 0;

  const state = () => {
    try {
      return av.getState();
    } catch {
      return 'NONE';
    }
  };

  const close = () => {
    session++;
    prepared = false;
    wantPlay = false;
    pendingSeek = null;
    now = 0;
    try {
      if (state() !== 'NONE') av.stop();
      av.close();
    } catch {}
  };

  const fail = (reason) => {
    video.error = { code: /NOT_SUPPORTED|UNSUPPORTED/i.test(String(reason)) ? 4 : 2, message: String(reason) };
    console.warn('AVPlay:', reason);
    emit('error');
  };

  const start = () => {
    close();
    const mine = session;
    video.error = null;
    try {
      av.open(url);
      av.setDisplayRect(0, 0, 1920, 1080);
      av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      av.setListener({
        onbufferingstart: () => emit('waiting'),
        onbufferingcomplete: () => (emit('canplay'), emit('playing')),
        oncurrentplaytime: (ms) => {
          now = ms / 1000;
          emit('timeupdate');
        },
        onstreamcompleted: () => emit('ended'),
        onerror: (e) => fail(e),
        onevent: () => {},
      });
      // Buffer maior: a conexao com o provedor oscila.
      try {
        av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 6);
      } catch {}
      av.prepareAsync(
        () => {
          if (mine !== session) return;
          prepared = true;
          emit('loadedmetadata');
          if (pendingSeek != null) seek(pendingSeek);
          if (wantPlay) play();
        },
        (e) => mine === session && fail(e)
      );
    } catch (e) {
      fail(e?.name || e);
    }
  };

  const seek = (sec) => {
    pendingSeek = null;
    try {
      av.seekTo(Math.max(0, sec) * 1000, () => emit('timeupdate'), () => {});
      now = sec;
    } catch {}
  };

  const play = () => {
    wantPlay = true;
    if (!prepared) return;
    try {
      av.play();
      emit('play');
    } catch (e) {
      fail(e?.name || e);
    }
  };

  const video = {
    error: null,
    muted: false,
    volume: 1,
    buffered: { length: 0 },

    get paused() {
      return state() !== 'PLAYING' && !(wantPlay && !prepared);
    },
    get duration() {
      try {
        const d = av.getDuration() / 1000;
        return d > 0 ? d : NaN;
      } catch {
        return NaN;
      }
    },
    get currentTime() {
      return now;
    },
    set currentTime(sec) {
      if (prepared) seek(sec);
      else pendingSeek = sec;
    },
    set src(value) {
      url = value;
      start();
    },

    play() {
      play();
      return Promise.resolve();
    },
    pause() {
      wantPlay = false;
      if (state() === 'PLAYING') {
        try {
          av.pause();
        } catch {}
      }
      emit('pause');
    },
    removeAttribute() {
      url = '';
      close();
    },
    load() {},

    addEventListener(type, fn, opts) {
      (listeners[type] ||= []).push({ fn, once: !!opts?.once });
    },
  };

  window.TvVideo = video;

  // O fundo do <html> tambem precisa sumir enquanto o player esta aberto.
  new MutationObserver(() => document.documentElement.classList.toggle('tv-playing', document.body.classList.contains('playing'))).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // Se a TV suspender o app (botao Home), o video para junto.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state() === 'PLAYING') video.pause();
  });
})();
