/**
 * Controle remoto da TV: as setas andam pelo que estiver na tela, OK clica,
 * Voltar volta. Funciona por geometria (o vizinho mais proximo na direcao),
 * entao as telas do app nao precisam saber que estao numa TV.
 */

const TV_KEYS = { back: 10009, play: 415, pause: 19, playPause: 10252, ff: 417, rw: 412, chUp: 427, chDown: 428, stop: 413 };

const Focus = {
  // Seletor do que pode receber foco. As setas das fileiras sao so para mouse.
  SEL: '#topbar button, #view button, #view input, #view a[href]',

  init() {
    document.body.classList.add('tv');
    try {
      tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', 'MediaStop', 'ChannelUp', 'ChannelDown']);
    } catch {}
    // Na captura: chega antes dos atalhos de teclado do app.
    window.addEventListener('keydown', (e) => this.onKey(e), true);

    // Toda vez que a tela e redesenhada o foco volta para algum lugar sensato:
    // tela nova -> botao principal; voltar -> o card de onde voce saiu;
    // a mesma tela redesenhada (ex.: chegou o "em alta") -> o mesmo card.
    const go = App.go.bind(App);
    App.go = (...args) => {
      if (App.current) App.current.focusKey = this.keyOf(document.activeElement);
      this.nextKey = null;
      go(...args);
    };
    const back = App.back.bind(App);
    App.back = () => {
      this.nextKey = App.stack[App.stack.length - 2]?.focusKey || null;
      back();
    };
    const render = App.render.bind(App);
    App.render = (...args) => {
      const navigating = this.nextKey !== undefined;
      const active = document.activeElement;
      const key = navigating ? this.nextKey : this.keyOf(active);
      this.nextKey = undefined;
      render(...args);
      // Redesenho por dados que chegaram (em alta, catalogo) com voce no menu de cima: o foco fica la.
      if (!navigating && active?.closest?.('#topbar') && active.isConnected) return this.focus(active, false);
      this.settle(key);
    };
    // Detalhe de filme/serie chega depois da tela: se o foco ficou perdido, vai para o botao principal.
    document.addEventListener('view-filled', () => {
      const active = document.activeElement;
      if (Player.open_ || this.exitBox || (active && active !== document.body && active.isConnected && active.closest('#view'))) return;
      const el = this.first(null);
      if (el?.closest('#view')) this.focus(el, false);
    });
    // De longe, o tamanho "Grande" e o ponto de partida.
    if (store.get('scale', null) == null) store.set('scale', 1.18);
    App.applyScale(store.get('scale', 1.18));
  },

  keyOf(el) {
    return el?.closest?.('[data-key]')?.dataset.key || null;
  },

  visible(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    // Setas das fileiras e pontinhos do destaque sao so para mouse (e sao recriados a toda hora).
    if (el.disabled || el.closest('[hidden], .arrow, .hero-dots')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },

  all() {
    // Com a pergunta de sair aberta, so os botoes dela existem.
    const sel = this.exitBox ? '.tv-exit button' : this.SEL;
    return [...document.querySelectorAll(sel)].filter((el) => this.visible(el));
  },

  /** Primeiro foco de uma tela: o card de onde veio, o botao principal ou o primeiro item. */
  first(key) {
    const list = this.all();
    return (
      (key && list.find((el) => el.dataset.key === key)) ||
      list.find((el) => el.matches('#view .actions .btn.primary')) ||
      list.find((el) => el.matches('#view .card, #view .chip')) ||
      list.find((el) => el.closest('#view')) ||
      list.find((el) => el.matches('#nav button.on'))
    );
  },

  /** As telas montam conteudo aos poucos; tenta por ate 2 segundos. */
  settle(key) {
    let tries = 0;
    // Uma tela nova cancela a busca de foco da anterior (senao ela rouba o foco depois).
    const id = (this.settleId = (this.settleId || 0) + 1);
    const attempt = () => {
      if (Player.open_ || id !== this.settleId) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && this.visible(active) && !key && tries) return;
      const el = this.first(key);
      // Espera o conteudo da tela; o menu do topo so e a ultima opcao.
      // Tela com destaque no topo: comeca no "Assistir" dele, que chega um pouco depois.
      const heroPending = !key && document.querySelector('#view .hero') && !el?.closest('.hero') && tries < 15;
      const inView = el?.closest('#view') && !heroPending;
      if (el && (key ? el.dataset.key === key || tries > 12 : inView || tries > 15)) return this.focus(el, false);
      if (++tries < 40) setTimeout(attempt, 100);
      else if (el) this.focus(el, false);
    };
    setTimeout(attempt, 60);
  },

  focus(el, smooth = true) {
    // Classe propria alem do :focus: o destaque aparece mesmo se a janela perder o foco.
    document.querySelectorAll('.tv-focus').forEach((x) => x.classList.remove('tv-focus'));
    el.classList.add('tv-focus');
    el.focus({ preventScroll: true });
    const behavior = smooth ? 'smooth' : 'auto';

    // Fileira horizontal: completa os cards que faltam e anda para o card ficar inteiro na tela.
    const track = el.closest('.track');
    track?._rest?.();
    if (track) {
      const left = el.offsetLeft - track.offsetLeft;
      if (left < track.scrollLeft + 10 || left + el.offsetWidth > track.scrollLeft + track.clientWidth - 10) {
        track.scrollTo({ left: Math.max(0, left - track.clientWidth * 0.08), behavior });
      }
    }
    if (el.closest('#topbar')) return;
    // Destaque do topo: volta ao inicio da tela. Resto: mantem o item no terco de cima.
    if (el.closest('.hero, .detail')) return scrollTo({ top: 0, behavior });
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * 0.22 || r.bottom > innerHeight * 0.92) scrollBy({ top: r.top - innerHeight * 0.3, behavior });
  },

  /** Vizinho mais proximo na direcao: distancia no eixo + desvio lateral (que pesa mais). */
  move(dir) {
    const cur = document.activeElement;
    if (!cur || cur === document.body || !this.visible(cur)) {
      const el = this.first(null);
      if (el) this.focus(el);
      return;
    }
    const a = cur.getBoundingClientRect();
    const horizontal = dir === 'left' || dir === 'right';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;
    let best = null;
    let bestScore = Infinity;
    for (const el of this.all()) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      // Distancia na direcao pedida, de borda a borda.
      const along = horizontal ? (sign > 0 ? b.left - a.right : a.left - b.right) : sign > 0 ? b.top - a.bottom : a.top - b.bottom;
      if (along < -a[horizontal ? 'width' : 'height'] / 2) continue;
      const centerA = horizontal ? a.top + a.height / 2 : a.left + a.width / 2;
      const centerB = horizontal ? b.top + b.height / 2 : b.left + b.width / 2;
      const overlap = horizontal ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      // Para os lados, so na mesma linha; para cima/baixo, qualquer coluna (prefere a mais perto).
      if (horizontal && overlap <= 0) continue;
      const side = overlap > 0 && horizontal ? 0 : Math.abs(centerB - centerA);
      const score = Math.max(0, along) + side * (horizontal ? 3 : 0.5);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    // Subindo do conteudo para o menu: cai na aba aberta, nao no botao que estiver mais perto na tela.
    if (best?.closest('#nav') && !cur.closest('#topbar')) {
      const tab = document.querySelector('#nav button.on');
      if (tab && this.visible(tab)) best = tab;
    }
    if (best) this.focus(best);
    else if (dir === 'up') scrollTo({ top: 0, behavior: 'smooth' });
  },

  /* ------------------------------------------------------------ teclas */

  backPressedAt: 0,
  nextKey: undefined,

  onKey(e) {
    const code = e.keyCode;
    if (Player.open_) return this.playerKey(e, code);

    if (code === TV_KEYS.back) {
      e.preventDefault();
      e.stopPropagation();
      if (this.exitBox) return this.closeExit();
      if (document.activeElement?.tagName === 'INPUT') return document.activeElement.blur();
      if (App.stack.length > 1) return App.back();
      // Sem tela para voltar: primeiro sobe para o menu de cima; de la, pergunta se quer sair.
      if (!document.activeElement?.closest('#topbar')) {
        const tab = document.querySelector('#nav button.on') || document.querySelector('#nav button');
        return this.focus(tab);
      }
      return this.askExit();
    }

    // OK do controle: clica no que estiver em foco (campo de texto abre o teclado da TV).
    if ((e.key === 'Enter' || code === 13) && document.activeElement?.tagName !== 'INPUT') {
      const el = document.activeElement;
      if (el && el !== document.body) {
        e.preventDefault();
        e.stopPropagation();
        el.click();
      }
      return;
    }

    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key] || { 37: 'left', 39: 'right', 38: 'up', 40: 'down' }[code];
    if (!dir) return;
    // Dentro de um campo de texto, esquerda/direita andam no texto.
    if (document.activeElement?.tagName === 'INPUT' && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();
    e.stopPropagation();
    // Qualquer seta cancela a busca de foco pendente: quem manda e voce.
    this.settleId = (this.settleId || 0) + 1;
    const now = performance.now();
    if (e.repeat && now - (this.lastMove || 0) < 70) return;
    this.lastMove = now;
    this.move(dir);
  },

  /* ------------------------------------------------------ sair do app */

  exitBox: null,

  askExit() {
    this.exitFrom = document.activeElement;
    const no = h('button', { class: 'btn', onclick: () => this.closeExit() }, 'Não');
    const yes = h('button', { class: 'btn primary', onclick: () => native.quit() }, 'Sim');
    this.exitBox = h('div', { class: 'tv-exit' }, h('div', { class: 'tv-exit-box' }, h('h2', {}, 'Sair do IPTV Cinema?'), h('div', { class: 'actions' }, yes, no)));
    document.body.append(this.exitBox);
    // "Nao" ja vem selecionado: um OK sem querer nao fecha o app.
    this.focus(no, false);
  },

  closeExit() {
    this.exitBox?.remove();
    this.exitBox = null;
    if (this.exitFrom?.isConnected) this.focus(this.exitFrom, false);
  },

  /** No player: OK pausa, lados avancam, cima/baixo trocam de canal; Voltar sai. */
  playerKey(e, code) {
    const ui = Player.ui;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
      Player.poke();
    };
    // Canal ao vivo: barra de programacao, lista de canais e CH+/- (tizen/live.js).
    if (Player.session?.kind === 'live' && typeof Live !== 'undefined' && Live.cur && Live.onKey(e, code)) return;
    const isEnter = e.key === 'Enter' || code === 13;
    if (ui.error.classList.contains('on')) {
      if (isEnter) (stop(), ui.error.querySelector('.p-err-retry').click());
      else if (code === TV_KEYS.back) (stop(), Player.close());
      return;
    }
    if (ui.nextCard.classList.contains('on') && isEnter) return stop(), ui.nextCard.querySelector('.p-nc-go').click();

    switch (code) {
      case TV_KEYS.back:
        stop();
        if (ui.side.classList.contains('open')) ui.side.classList.remove('open');
        else Player.close();
        break;
      case TV_KEYS.playPause:
        stop();
        Player.toggle();
        break;
      case TV_KEYS.play:
        stop();
        if (Player.video.paused) Player.toggle();
        break;
      case TV_KEYS.pause:
        stop();
        if (!Player.video.paused) Player.toggle();
        break;
      case TV_KEYS.ff:
        stop();
        Player.seekBy(30);
        break;
      case TV_KEYS.rw:
        stop();
        Player.seekBy(-10);
        break;
      case TV_KEYS.stop:
        stop();
        Player.close();
        break;
      case TV_KEYS.chUp:
      case TV_KEYS.chDown:
        stop();
        if (Player.session?.channels) Player.switchChannel(code === TV_KEYS.chUp ? -1 : 1);
        break;
      // Setas e OK seguem para o Player.onKey de sempre.
    }
  },
};

Focus.init();
