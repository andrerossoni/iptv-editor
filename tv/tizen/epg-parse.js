/**
 * Leitura dos guias de programacao (XMLTV), compartilhada pelo live.js e pelo
 * epg-worker.js. O worker baixa e le os arquivos (ate ~15 MB cada) fora da
 * linha principal, para a tela da TV nao travar enquanto isso.
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

/**
 * Baixa uma fonte e separa a grade de cada canal da lista.
 * list: [{ key, name, epg: [ids do provedor] }]
 */
async function readXmltv(src, list) {
  let xml = await fetchXml(src.url);
  if (!xml) return {};
  const names = xmltvNames(xml);
  const want = new Map();
  const twins = new Map();
  for (const ch of list) twins.set(epgKey(ch.name), (twins.get(epgKey(ch.name)) || 0) + 1);
  for (const ch of list) {
    const ids = (src.byId ? ch.epg : epgAliases(ch.name).map((k) => names.get(k))).filter((id) => id && sameKind(ch.name, names.labels.get(id), twins.get(epgKey(ch.name)) > 1));
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
}
