/**
 * Ao vivo na TV: uma lista unica de canais, na ordem da sua lista, sem pastas
 * e sem "HD/FHD" repetido. Cada canal pode ter varias versoes; o app escolhe
 * sozinho a que abre mais rapido (e aprende com o uso), e se uma falhar ou
 * demorar, passa para a proxima sem voce perceber.
 *
 * Controle no canal:
 *   CH+ / CH-  troca de canal (o unico jeito de trocar sem abrir a lista)
 *   ↓          barra de programacao; nela ← → andam no horario e ↑ ↓ espiam
 *              outros canais sem trocar
 *   OK         lista de canais a direita; OK nela troca para o escolhido
 *   Voltar     fecha a barra/lista, ou sai do canal
 */

const QUALITY = /\b(fhd|full\s*hd|uhd|4k|hd|sd|h\.?265|hevc)\b/gi;

/** "20261027190500 -0300" -> milissegundos. */
function xmltvTime(s) {
  const m = String(s || '').match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])(\d\d)(\d\d)/);
  if (!m) return 0;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offset = (+m[8] * 60 + +m[9]) * 60000 * (m[7] === '-' ? -1 : 1);
  return utc - offset;
}

/**
 * Guias publicos de TV do Brasil (XMLTV), na ordem de preferencia para desempate.
 * Fontes da mesma familia vem do mesmo autor: uma nao confirma a outra.
 * O open-epg aceita so 20 downloads por arquivo por dia (ate a checagem conta):
 * ele e baixado direto, a cada 6h.
 */
const EPG_SOURCES = [
  { name: 'BrazilTVEPG', family: 'limaalef', url: 'https://raw.githubusercontent.com/limaalef/BrazilTVEPG/main/epg.xml' },
  { name: 'Claro', family: 'limaalef', url: 'https://raw.githubusercontent.com/limaalef/BrazilTVEPG/main/claro.xml' },
  { name: 'open-epg', family: 'open-epg', url: 'https://www.open-epg.com/files/brazil4.xml.gz', every: 6 * 3600000 },
  { name: 'epgshare', family: 'epgshare', url: 'https://epgshare01.online/epgshare01/epg_ripper_BR2.xml.gz' },
  { name: 'open-epg 1', family: 'open-epg', url: 'https://www.open-epg.com/files/brazil1.xml.gz', every: 6 * 3600000 },
];

/** Baixa um XMLTV; os .gz sao descompactados na propria TV. Desiste em 2 minutos. */
async function fetchXml(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return '';
    if (!url.endsWith('.gz')) return await res.text();
    if (typeof DecompressionStream === 'undefined') return '';
    return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  } finally {
    clearTimeout(timer);
  }
}

/** Data e tamanho do arquivo sem baixar (HEAD): diz se a fonte mudou desde a ultima vez. */
async function fileStamp(url) {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    if (!res.ok) return '';
    const stamp = [res.headers.get('last-modified'), res.headers.get('content-length')].filter(Boolean).join('|');
    return stamp;
  } catch {
    return '';
  }
}

/** Nome de canal para cruzar entre fontes: sem qualidade, acento, "TV", "Brasil" etc. */
function epgKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¹²³]/g, '')
    .replace(/\+/g, ' plus ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(fhd|full\s*hd|uhd|4k|hd|sd|h\.?265|hevc|br|brasil|brazil|canal|channel|tv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b0+(\d)/g, '$1')
    .trim();
}

/** Jeitos de o mesmo canal aparecer nos guias ("TC Pipoca" = "Telecine Pipoca", "SBT SP" = "SBT" de Sao Paulo). */
function epgAliases(name) {
  const k = epgKey(name);
  const uf = k.replace(/ (ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)$/, '');
  const list = [k, k.replace(/^tc /, 'telecine '), k.replace(/ 1$/, ''), k.replace(/\bsp\b/, 'sao paulo'), k.replace(/\bsp\b/, '').trim(), uf];
  // "BANDSPORTS" e "Band Sports" sao o mesmo canal: tenta tambem sem espacos.
  // "REDETV!" grudado: o "TV" nao sai sozinho como em "Rede TV".
  return [...new Set([...list, ...list.map((x) => x.replace(/ /g, '')), k.replace(/tv\b/, '').trim()])].filter(Boolean);
}

/**
 * Sem o "TV", "TV Universal" e "Universal TV" viram o mesmo nome. Quando dois
 * canais da lista colidem assim, cada um so aceita guia com o "TV" na mesma
 * posicao; nos outros, so barra o "TV" na ponta oposta.
 */
const tvAt = (name) => {
  const s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(QUALITY, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return /^tv\b/.test(s) ? 'start' : /\btv$/.test(s) ? 'end' : /\btv\b/.test(s) ? 'mid' : '';
};
function sameKind(chName, labels, strict) {
  const ch = tvAt(chName);
  if (!labels?.length) return !strict || ch !== 'start';
  // Nos gemeos, o "TV ..." so fica com guia que seja so dele (o codigo do provedor as vezes e o mesmo dos dois).
  if (strict) return ch === 'start' ? labels.every((l) => tvAt(l) === 'start') : !labels.some((l) => tvAt(l) === 'start');
  return !labels.every((l) => (ch === 'start' && tvAt(l) === 'end') || (ch === 'end' && tvAt(l) === 'start'));
}

const xmlText = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .trim();

/** Nomes dos canais de um XMLTV: "record sp" -> id do canal no arquivo (e os rotulos de cada id). */
function xmltvNames(xml) {
  const names = new Map();
  names.labels = new Map();
  for (const m of xml.matchAll(/<channel\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    for (const d of m[2].matchAll(/<display-name[^>]*>([^<]+)</g)) {
      // "Sao Paulo/SP  Record HD" -> "record sp" e "record"
      const raw = xmlText(d[1]);
      if (!names.labels.has(m[1])) names.labels.set(m[1], []);
      names.labels.get(m[1]).push(raw.replace(/^.*?\/[A-Z]{2}\s+/, ''));
      const city = raw.match(/^.*?\/([A-Z]{2})\s+(.*)$/);
      const keys = city ? [`${epgKey(city[2])} ${city[1].toLowerCase()}`, epgKey(city[2])] : [epgKey(raw)];
      for (const k of keys.flatMap((x) => [x, x.replace(/ /g, '')])) if (k && !names.has(k)) names.set(k, m[1]);
    }
  }
  return names;
}

/**
 * Programas de um XMLTV, lidos com expressoes regulares (bem mais leve que
 * montar o XML inteiro na memoria da TV). So dos canais pedidos, de 6h atras
 * ate 2 dias a frente.
 */
function xmltvProgs(xml, ids) {
  const since = Date.now() - 6 * 3600000;
  const until = Date.now() + 2 * 86400000;
  const progs = new Map();
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const id = (m[1].match(/\bchannel="([^"]+)"/) || [])[1];
    if (!ids.has(id)) continue;
    const end = xmltvTime((m[1].match(/\bstop="([^"]+)"/) || [])[1]);
    const start = xmltvTime((m[1].match(/\bstart="([^"]+)"/) || [])[1]);
    if (end < since || start > until) continue;
    const title = xmlText((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const desc = xmlText((m[2].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1]).slice(0, 400);
    if (!progs.has(id)) progs.set(id, []);
    progs.get(id).push([start, end, title, desc]);
  }
  return progs;
}

/** A fonte so vale para o canal se tiver o programa de agora e mais alguns pela frente. */
function hasNow(rows) {
  const now = Date.now();
  return rows.some(([s, e]) => s <= now && e > now) && rows.filter(([s]) => s > now && s < now + 86400000).length >= 2;
}

/** Titulo comparavel entre fontes: "VT - Glory: 110" = "Glory 110", "Rookie, The" = "The Rookie". */
function titleKey(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*(vt|ao vivo|reprise|inedito)\s*[-:]\s*/, '')
    .replace(/,\s*(the|o|a)\s*$/, '')
    .replace(/^(the|o|a|os|as)\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16);
}

const UNAVAILABLE = /^(canalnodisponib|nodisponible|canalindisponive|indisponivel|semprogramacao|semgrade|notavailable)/;

const sameTitle = (a, b) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

/**
 * Entre as fontes que tem o canal, fica a que as outras confirmam: em agora,
 * daqui 1h e daqui 2h, cada outra familia que mostra o mesmo programa conta
 * ponto. Titulo que e so o nome do canal ("Premiere 5") quase nao vale.
 */
function pickSource(cands, chName) {
  const now = Date.now();
  // "Canal no disponible", "Sem programacao": a fonte nao tem a grade, so diz que nao tem.
  cands = cands.filter((c) => !UNAVAILABLE.test(titleKey(c.rows.find(([s, e]) => s <= now && e > now)?.[2])));
  const self = epgKey(chName).replace(/ /g, '');
  const at = (rows, t) => rows.find(([s, e]) => s <= t && e > t);
  const filler = (k) => !k || k === self || self.startsWith(k) || /^(programacao|semprogramacao|aseguir|intervalo|encerramento|fimdetransmiss)/.test(k);
  let best = null;
  let bestScore = -1;
  cands.forEach((c, order) => {
    let score = -order * 0.01;
    for (const t of [now, now + 3600000, now + 7200000]) {
      const p = at(c.rows, t);
      if (!p) continue;
      const k = titleKey(p[2]);
      if (filler(k)) {
        score += 0.2;
        continue;
      }
      const agree = new Set(cands.filter((o) => o.family !== c.family && sameTitle(k, titleKey(at(o.rows, t)?.[2]))).map((o) => o.family));
      score += 1 + 2 * agree.size + (p[3] ? 0.2 : 0);
    }
    if (hasNow(c.rows)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  });
  return bestScore > 0 ? best : null;
}

const Live = {
  channels: [],
  builtFrom: null,
  cur: null,
  stats: store.get('live-stats', {}),
  epgCache: new Map(),

  /* ---------------------------------------------------------- canais */

  /** Junta as versoes do mesmo canal: "HBO HD" e "HBO FHD" viram "HBO". */
  build() {
    if (this.builtFrom === Data.items.live) return this.channels;
    this.builtFrom = Data.items.live;
    const byBase = new Map();
    const list = [];
    for (const cat of Data.cats.live) {
      for (const it of cat.items) {
        const base = this.baseKey(it.name);
        let ch = byBase.get(base);
        if (!ch) {
          ch = { key: `ch:${base}`, name: this.baseName(it.name), logo: '', variants: [] };
          byBase.set(base, ch);
          list.push(ch);
        }
        ch.variants.push(it);
        ch.logo ||= it.poster;
      }
    }
    list.forEach((ch, i) => (ch.num = i + 1));
    this.byVariant = new Map(list.flatMap((ch) => ch.variants.map((v) => [v.key, ch])));
    return (this.channels = list);
  },

  baseKey(name) {
    const s = String(name || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\+/g, ' plus ')
      .replace(QUALITY, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b0+(\d)/g, '$1')
      .trim();
    return s || String(name);
  },

  baseName(name) {
    return String(name).replace(QUALITY, ' ').replace(/\s*-\s*$/, '').replace(/\s+-\s+(?=\d)/, ' ').replace(/\s+/g, ' ').trim() || name;
  },

  find(item) {
    this.build();
    return this.byVariant.get(item.key) || this.channels.find((c) => c.key === item.key) || null;
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

  play(ch) {
    this.build();
    this.closeOverlays();
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
      sub: '',
      url: Data.streamUrl('live', v.id, 'm3u8'),
      key: v.key,
      streamId: v.id,
      onClose: () => {
        clearTimeout(this.cur?.timer);
        this.cur = null;
        this.closeOverlays();
        App.refresh();
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
    this.record(c.order[c.i], false);
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

  step(dir) {
    const list = this.build();
    const i = list.indexOf(this.cur.ch);
    this.play(list[(i + dir + list.length) % list.length]);
  },

  /* ------------------------------------------------------ programacao */

  /**
   * Programacao de todos os canais, em segundo plano, guardada na TV — a barra
   * e a lista nunca esperam.
   *
   * De hora em hora (e quando a TV volta da espera) pergunta a cada fonte so a
   * data e o tamanho do arquivo; baixa de novo apenas a que mudou. Cada fonte
   * fica guardada separada, e a escolha de qual vale para cada canal e refeita
   * a cada checagem: a que as outras fontes confirmam (pickSource). Fonte que
   * falhar nao apaga nada: segue a ultima versao boa dela e tenta na proxima.
   */
  allEpg: null,
  srcData: {},
  tried: {},

  async loadAll() {
    const list = this.build();
    const chSig = list.map((c) => c.key).join(',');
    if (!this.allEpg) {
      const cached = await native.cacheGet('epg-guide').catch(() => null);
      if (cached?.by) this.useAll(cached);
    }
    const q = new URLSearchParams({ username: Data.cfg.user, password: Data.cfg.pass });
    const sources = [...EPG_SOURCES, { name: 'provedor', family: 'provedor', url: `${Data.cfg.server}/xmltv.php?${q}`, byId: true }];
    for (const src of sources) {
      const old = this.srcData[src.name] || (this.srcData[src.name] = await native.cacheGet(`epg-src:${src.name}`).catch(() => null));
      const age = Date.now() - (old?.at || 0);
      const stamp = src.every ? '' : await fileStamp(src.url);
      // Sem como saber se mudou: baixa de novo a cada 3h. Sabendo: so quando mudar (e no maximo 1 dia sem baixar).
      const fresh = old && old.chSig === chSig && age < 86400000 && (stamp ? stamp === old.stamp : age < (src.every || 3 * 3600000));
      // Tentativa que falhou tambem conta, para nao gastar a cota do open-epg de hora em hora.
      if (fresh || Date.now() - (this.tried[src.name] || 0) < (src.every || 0)) continue;
      this.tried[src.name] = Date.now();
      try {
        const by = await this.readSource(src, list);
        if (!Object.keys(by).length) continue;
        this.srcData[src.name] = { at: Date.now(), stamp, chSig, by };
        native.cacheSet(`epg-src:${src.name}`, this.srcData[src.name]);
      } catch (err) {
        console.warn('Programacao: falhou', src.name, err);
      }
    }
    this.choose(list, sources, chSig);
  },

  /** Baixa uma fonte e separa a grade de cada canal da lista. */
  async readSource(src, list) {
    let xml = await fetchXml(src.url);
    if (!xml) return {};
    const names = xmltvNames(xml);
    const want = new Map();
    const twins = new Map();
    for (const ch of list) twins.set(epgKey(ch.name), (twins.get(epgKey(ch.name)) || 0) + 1);
    for (const ch of list) {
      const ids = (src.byId ? ch.variants.map((v) => v.epg) : epgAliases(ch.name).map((k) => names.get(k))).filter((id) => id && sameKind(ch.name, names.labels.get(id), twins.get(epgKey(ch.name)) > 1));
      if (ids.length) want.set(ch.key, [...new Set(ids)]);
    }
    const progs = xmltvProgs(xml, new Set([...want.values()].flat()));
    xml = null;
    const by = {};
    for (const [key, ids] of want) {
      const rows = ids.map((id) => progs.get(id)).find((r) => r?.length);
      if (rows) by[key] = rows;
    }
    return by;
  },

  /** Para cada canal, a fonte que as outras confirmam agora. */
  choose(list, sources, chSig) {
    const by = {};
    const from = {};
    for (const ch of list) {
      const cands = sources
        .map((src) => ({ src: src.name, family: src.family, rows: this.srcData[src.name]?.chSig === chSig ? this.srcData[src.name].by[ch.key] : null }))
        .filter((c) => c.rows?.length);
      const pick = cands.length && pickSource(cands, ch.name);
      if (!pick) continue;
      by[ch.key] = pick.rows;
      from[ch.key] = pick.src;
    }
    const data = { at: Date.now(), by, from };
    native.cacheSet('epg-guide', data);
    this.useAll(data);
  },

  useAll(data) {
    this.allEpg = data.by;
    this.epgFrom = data.from || {};
    this.epgCache.clear();
  },

  async epg(ch) {
    const hit = this.epgCache.get(ch.key);
    if (hit && Date.now() - hit.t < 10 * 60000) return hit.list;
    const now = Date.now();
    // Primeiro a programacao ja baixada, se ela tiver o programa de agora.
    const rows = this.allEpg?.[ch.key];
    if (rows?.some(([s, e]) => s <= now && e > now)) {
      const list = this.tidy(rows.map(([start, end, title, desc]) => ({ start, end, title, desc })));
      this.epgCache.set(ch.key, { t: Date.now(), list });
      return list;
    }
    // Faltou: pergunta ao provedor so deste canal, na hora.
    const dec = (s) => {
      try {
        return decodeURIComponent(escape(atob(s || '')));
      } catch {
        return s || '';
      }
    };
    let list = [];
    for (const v of this.ranked(ch)) {
      try {
        const d = await Data.api('get_simple_data_table', { stream_id: v.id });
        list = (d.epg_listings || []).map((e) => ({ title: dec(e.title), desc: dec(e.description), start: +e.start_timestamp * 1000, end: +e.stop_timestamp * 1000 }));
      } catch {}
      if (list.length) break;
    }
    const since = Date.now() - 12 * 3600000;
    list = this.tidy(list.filter((e) => e.end > since && !UNAVAILABLE.test(titleKey(e.title))));
    // Sem nada no provedor tambem: fica o que havia guardado (programas futuros) e tenta de novo em 30 min.
    if (!list.length && rows?.length) list = this.tidy(rows.map(([start, end, title, desc]) => ({ start, end, title, desc })));
    this.epgCache.set(ch.key, { t: list.length ? Date.now() : Date.now() - 10 * 60000 + 30 * 60000, list });
    return list;
  },

  /** O XMLTV do provedor traz programas sobrepostos e alguns com duracao absurda: fica so a sequencia limpa. */
  tidy(list) {
    const out = [];
    for (const e of list.slice().sort((a, b) => a.start - b.start)) {
      if (!e.start || e.end - e.start > 6 * 3600000 || e.end <= e.start) continue;
      const prev = out[out.length - 1];
      if (prev && e.start < prev.end - 60000) continue;
      out.push(e);
    }
    return out;
  },

  nowIndex(list) {
    const now = Date.now();
    const i = list.findIndex((e) => e.start <= now && e.end > now);
    return i >= 0 ? i : list.findIndex((e) => e.start > now);
  },

  /* ------------------------------------------------- barra de baixo */

  ui: null,

  mount() {
    if (this.ui) return;
    const bar = h('div', { class: 'lv-bar' });
    const side = h('div', { class: 'lv-list' }, h('div', { class: 'lv-list-head' }, 'Canais'), h('div', { class: 'lv-items' }));
    $('#player').append(bar, side);
    this.ui = { bar, side, items: side.querySelector('.lv-items') };
  },

  closeOverlays() {
    if (!this.ui) return;
    this.ui.bar.classList.remove('on');
    this.ui.side.classList.remove('on');
    this.barState = null;
    this.listState = null;
  },

  barState: null,

  openBar(ch = this.cur.ch) {
    this.mount();
    this.ui.side.classList.remove('on');
    this.listState = null;
    this.barState = { ch, off: 0 };
    this.ui.bar.classList.add('on');
    this.renderBar();
  },

  /**
   * A barra tem sempre a mesma altura e as mesmas partes, com ou sem
   * programacao: so o conteudo muda. Sinopse longa rola devagar, em loop.
   */
  async renderBar() {
    const s = this.barState;
    if (!s) return;
    this.armBarTimer();
    const ch = s.ch;
    const live = ch === this.cur?.ch;
    const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const day = (t) => {
      const diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
      return diff === 0 ? '' : diff === 1 ? 'Amanhã, ' : diff === -1 ? 'Ontem, ' : `${new Date(t).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' })}, `;
    };
    const paint = ({ when = '', label = '', title, desc = '', pct = null, chips = [] }) =>
      fill(
        this.ui.bar,
        h(
          'div',
          { class: 'lv-head' },
          h('div', { class: 'lv-logo' }, ch.logo ? h('img', { src: ch.logo, alt: '', onerror: (e) => e.target.remove() }) : null),
          h('div', { class: 'lv-num' }, ch.num),
          h('div', { class: 'lv-name' }, ch.name),
          h('div', { class: `lv-tag${live ? ' live' : ''}` }, live ? 'AO VIVO' : 'OUTRO CANAL'),
          h('div', { class: 'lv-when' }, label ? h('span', { class: 'lv-label' }, label) : null, when)
        ),
        h('div', { class: 'lv-title' }, title),
        h('div', { class: 'lv-progress' }, pct == null ? null : h('i', { style: { width: `${pct * 100}%` } })),
        h('div', { class: 'lv-desc' }, h('p', {}, desc)),
        h('div', { class: 'lv-strip' }, chips),
        this.hints()
      );

    paint({ title: 'Carregando programação…' });
    const list = await this.epg(ch);
    if (this.barState !== s) return;
    const base = this.nowIndex(list);
    if (!list.length || base < 0) {
      paint({ title: 'Sem programação disponível para este canal.' });
      return;
    }
    s.off = Math.max(-base, Math.min(list.length - 1 - base, s.off));
    const i = base + s.off;
    const e = list[i];
    const now = Date.now();
    const onNow = e.start <= now && e.end > now;
    paint({
      label: onNow ? 'Agora' : e.end <= now ? 'Já passou' : s.off === 1 ? 'A seguir' : 'Mais tarde',
      when: `${day(e.start)}${hm(e.start)} – ${hm(e.end)}`,
      title: e.title || 'Sem título',
      desc: e.desc || '',
      pct: onNow ? Math.min(1, (now - e.start) / (e.end - e.start)) : null,
      chips: list
        .slice(Math.max(0, i - 1), i + 4)
        .map((x) => h('div', { class: `lv-chip${x === e ? ' on' : ''}${x.end <= now ? ' past' : ''}` }, h('b', {}, `${day(x.start)}${hm(x.start)}`), h('span', {}, x.title))),
    });
    this.scrollDesc();
  },

  /** Sinopse maior que as duas linhas: desce devagar, para, e volta ao comeco. */
  scrollDesc() {
    const box = this.ui.bar.querySelector('.lv-desc');
    const p = box?.firstChild;
    if (!p) return;
    requestAnimationFrame(() => {
      const extra = p.scrollHeight - box.clientHeight;
      if (extra <= 2) return;
      p.style.setProperty('--lv-extra', `-${extra}px`);
      p.style.animationDuration = `${Math.max(8, extra / 6)}s`;
      p.classList.add('rolling');
    });
  },

  hints() {
    return h('div', { class: 'lv-hints' }, '◀ ▶  programação', h('span', {}, '▲ ▼  outros canais'), h('span', {}, 'OK  assistir este canal'), h('span', {}, 'CH + / –  trocar de canal'));
  },

  armBarTimer() {
    clearTimeout(this.barTimer);
    this.barTimer = setTimeout(() => this.barState && (this.ui.bar.classList.remove('on'), (this.barState = null)), 12000);
  },

  /* --------------------------------------------- lista da direita */

  listState: null,

  openList(ch = this.cur.ch) {
    this.mount();
    this.ui.bar.classList.remove('on');
    this.barState = null;
    const list = this.build();
    this.listState = { i: Math.max(0, list.indexOf(ch)) };
    this.ui.items.replaceChildren(
      ...list.map((c) =>
        h(
          'div',
          { class: `lv-row${c === this.cur?.ch ? ' current' : ''}` },
          h('div', { class: 'lv-num' }, c.num),
          c.logo ? h('img', { src: c.logo, alt: '', loading: 'lazy', onerror: (e) => (e.target.style.visibility = 'hidden') }) : h('i'),
          h('div', { class: 'lv-row-text' }, h('div', { class: 'lv-name' }, c.name), h('div', { class: 'lv-now' }))
        )
      )
    );
    this.ui.side.classList.add('on');
    this.moveList(0);
  },

  moveList(d) {
    const s = this.listState;
    const rows = this.ui.items.children;
    s.i = Math.max(0, Math.min(rows.length - 1, s.i + d));
    [...rows].forEach((r, j) => r.classList.toggle('sel', j === s.i));
    rows[s.i].scrollIntoView({ block: 'center' });
    // "Agora:" dos canais perto da selecao, sem pedir a programacao de todos de uma vez.
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      const list = this.build();
      const span = this.allEpg ? 25 : 5;
      for (let j = Math.max(0, s.i - span); j <= Math.min(rows.length - 1, s.i + span); j++) {
        const cell = rows[j].querySelector('.lv-now');
        if (cell.textContent) continue;
        this.epg(list[j]).then((epg) => {
          const e = epg[this.nowIndex(epg)];
          if (e && e.start <= Date.now()) cell.textContent = e.title;
        });
      }
    }, 250);
  },

  /* ----------------------------------------------------------- teclas */

  onKey(e, code) {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const key = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok' }[code] || { ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', Enter: 'ok' }[e.key];
    const list = this.build();

    if (Player.ui.error.classList.contains('on')) return false; // a tela de erro tem as teclas dela

    if (code === TV_KEYS.chUp || code === TV_KEYS.chDown) {
      stop();
      this.step(code === TV_KEYS.chUp ? 1 : -1);
      return true;
    }
    if (code === TV_KEYS.back) {
      stop();
      if (this.listState || this.barState) this.closeOverlays();
      else Player.close();
      return true;
    }
    // Sem pausar, avancar ou voltar no ao vivo.
    if ([TV_KEYS.play, TV_KEYS.pause, TV_KEYS.playPause, TV_KEYS.ff, TV_KEYS.rw].includes(code)) {
      stop();
      return true;
    }
    if (!key) return false;
    stop();

    if (this.listState) {
      if (key === 'up' || key === 'down') this.moveList(key === 'up' ? -1 : 1);
      else if (key === 'ok') this.play(list[this.listState.i]);
      return true;
    }
    if (this.barState) {
      const s = this.barState;
      if (key === 'left' || key === 'right') {
        s.off += key === 'right' ? 1 : -1;
        this.renderBar();
      } else if (key === 'up' || key === 'down') {
        const i = list.indexOf(s.ch);
        this.barState = { ch: list[(i + (key === 'down' ? 1 : -1) + list.length) % list.length], off: 0 };
        this.renderBar();
      } else if (key === 'ok') this.play(s.ch);
      return true;
    }
    if (key === 'down') this.openBar();
    else if (key === 'ok') this.openList();
    else Player.poke();
    return true;
  },

  /* ------------------------------------------------------------- tela */

  init() {
    // Programacao em segundo plano, assim que a lista de canais chegar; depois
    // confere as fontes de hora em hora, ao voltar da espera e quando a lista muda.
    let last = 0;
    const refresh = (minGap = 0) => {
      if (!Data.ready || !Data.cfg.server || Date.now() - last < minGap) return;
      last = Date.now();
      this.loading ||= this.loadAll().finally(() => (this.loading = null));
    };
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(15 * 60000));
    const wait = setInterval(() => {
      if (!Data.ready || !Data.cfg.server) return;
      clearInterval(wait);
      refresh();
      setInterval(() => refresh(), 3600000);
    }, 1000);
    // A lista do servidor chegou diferente da guardada: confere se a grade precisa ser refeita.
    const apply = Data.apply.bind(Data);
    Data.apply = (raw) => {
      apply(raw);
      if (this.loading) this.loading.then(() => refresh());
      else refresh();
    };

    Player.video.addEventListener('playing', () => this.started());
    Player.video.addEventListener('timeupdate', () => Player.video.currentTime > 0 && this.started());

    // A linha "Agora / A seguir" do canal usa a programacao ja baixada, sem pedir ao servidor a cada minuto.
    const loadEpg = Player.loadEpg.bind(Player);
    Player.loadEpg = () => {
      if (!this.cur) return loadEpg();
      const s = Player.session;
      const ch = this.cur.ch;
      const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const show = async () => {
        const list = await this.epg(ch);
        if (Player.session !== s) return;
        const i = this.nowIndex(list);
        const cur = list[i]?.start <= Date.now() ? list[i] : null;
        const nxt = list[cur ? i + 1 : i];
        const parts = [];
        if (cur) parts.push(`Agora: ${cur.title} (${hm(cur.start)}–${hm(cur.end)})`);
        if (nxt) parts.push(`A seguir: ${nxt.title} às ${hm(nxt.start)}`);
        Player.ui.sub.textContent = parts.join('   ·   ');
      };
      show();
      Player.epgTimer = setInterval(show, 60000);
    };

    const onError = Player.onError.bind(Player);
    Player.onError = () => (this.cur && Player.session?.kind === 'live' ? this.fail() : onError());

    // Qualquer canal (inicio, busca, "vistos recentemente") abre pela lista unica.
    App.playLive = (item) => {
      const ch = item.variants ? item : this.find(item);
      if (ch) this.play(ch);
    };

    // "TV ao vivo" no menu de cima ja entra no canal 1, sem tela de escolha.
    const nav = document.querySelector('#nav [data-view="live"]');
    nav.textContent = 'TV ao vivo';
    nav.onclick = () => {
      const first = Data.ready && this.build()[0];
      if (first) this.play(first);
      else toast('Carregando a lista de canais…');
    };

    App.viewLive = (view) => {
      if (!Data.ready) return App.splash('Carregando sua lista…');
      const list = this.build();
      const asItem = (c) => ({ kind: 'live', key: c.key, name: `${c.num}   ${c.name}`, poster: c.logo, variants: c.variants, num: c.num, ch: c });
      view.append(h('div', { class: 'page-head' }, h('h1', {}, 'Ao Vivo', h('span', { class: 'count' }, `${list.length} canais`))));
      const recent = [...new Set(Watch.history.map((x) => Data.byKey.get(x.key)).filter((x) => x?.kind === 'live').map((x) => this.find(x)).filter(Boolean))];
      if (recent.length) view.append(h('div', { class: 'rows' }, row('Vistos recentemente', recent.map(asItem), { noMore: true })));
      view.append(App.grid(list.map(asItem)));
    };
  },
};

Live.init();
