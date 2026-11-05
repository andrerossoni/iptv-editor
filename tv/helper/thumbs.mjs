/**
 * Ajudante de miniaturas para a TV, rodando no Mac (LaunchAgent).
 *
 * A TV nao consegue ler os quadros do video que ela toca. Entao, enquanto um
 * filme toca na TV, este ajudante tira fotos pequenas dele com o ffmpeg, uma
 * a cada 10 s, comecando perto de onde a pessoa esta (e de onde o pino da
 * linha do tempo estiver), e serve as fotos para a TV pela rede de casa.
 *
 *   GET /watch?kind=movie|series&id=&ext=&at=&dur=[&hold=s]  liga/atualiza
 *   GET /near/<kind>/<id>/<seg>        qual foto e a mais proxima (ate 30 s); 404 se nao houver
 *   GET /frame/<kind>/<id>/<seg>.jpg   a foto em si
 *   GET /thumb/<kind>/<id>/<seg>.jpg   foto mais proxima direto
 *   GET /stop?kind=&id=                para de gerar
 *   GET /src/<kind>/<id>.<ext>         video para o ffmpeg (so do proprio Mac)
 *   POST /state {state, adopt}         junta "Minha Lista", historico e progresso
 *                                      da TV e do Mac e devolve o resultado
 *
 * Desligar: sh tv/helper/uninstall.sh
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const PORT = 8790;
const STEP = 10;
const APP_DIR = path.join(os.homedir(), 'Library/Application Support/IPTV Cinema');
const DIR = path.join(APP_DIR, 'thumbs');
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p)) || 'ffmpeg';
const UA = { 'user-agent': 'IPTV Cinema' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const cfg = () => JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));

/* ------------------------------------------------ video para o ffmpeg */

// O provedor so aceita "a partir do byte N" depois de seguir os redirecionamentos
// na mao, e nunca um intervalo com fim. O link final vale alguns minutos.
const links = new Map();

async function resolve(kind, id, ext, fresh) {
  const k = `${kind}/${id}`;
  const hit = links.get(k);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60000) return hit.url;
  const { server, user, pass } = cfg();
  let url = `${server}/${kind === 'series' ? 'series' : 'movie'}/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.${ext}`;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { headers: UA, redirect: 'manual' });
    const loc = r.headers.get('location');
    await r.body?.cancel();
    if (!loc) break;
    url = new URL(loc, url).href;
  }
  links.set(k, { url, at: Date.now() });
  return url;
}

async function upstream(kind, id, ext, start) {
  for (const fresh of [false, true]) {
    const up = await fetch(await resolve(kind, id, ext, fresh), { headers: { ...UA, range: `bytes=${start}-` } });
    if (up.status === 206 || (up.status === 200 && start === 0)) return up;
    await up.body?.cancel();
  }
  throw new Error('provedor recusou o trecho');
}

/**
 * O indice do MP4 fica no comeco ou no fim do arquivo, e o ffmpeg le esse
 * indice em toda foto. Os dois pedacos ficam guardados na memoria: cada foto
 * vai ao provedor uma vez so (o trecho da cena).
 */
const HEAD = 12 * 1024 * 1024;
const TAIL = 48 * 1024 * 1024;
const files = new Map();

async function download(kind, id, ext, start, max) {
  const up = await upstream(kind, id, ext, start);
  const total = +(up.headers.get('content-range')?.split('/')[1] || up.headers.get('content-length'));
  const parts = [];
  let got = 0;
  for await (const chunk of up.body) {
    parts.push(chunk);
    got += chunk.length;
    if (got >= max) break;
  }
  return { start, buf: Buffer.concat(parts).subarray(0, max), total };
}

function file(kind, id, ext) {
  const k = `${kind}/${id}`;
  if (!files.has(k)) {
    const f = { segs: [], head: download(kind, id, ext, 0, HEAD) };
    f.head.then((seg) => ((f.total = seg.total), f.segs.push(seg))).catch(() => files.delete(k));
    files.set(k, f);
    // So os filmes em andamento ficam na memoria.
    while (files.size > 3) files.delete(files.keys().next().value);
  }
  return files.get(k);
}

async function source(req, res, kind, id, ext) {
  const start = +(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
  const f = file(kind, id, ext);
  await f.head;
  const total = f.total;
  let seg = f.segs.find((x) => start >= x.start && start < x.start + x.buf.length);
  // Pedido perto do fim (indice no fim do arquivo): baixa o fim inteiro uma vez.
  if (!seg && total - start <= TAIL) {
    f.tail ||= download(kind, id, ext, start, TAIL).then((x) => (f.segs.push(x), x));
    try {
      const t = await f.tail;
      if (start >= t.start) seg = t;
    } catch {
      f.tail = null;
    }
  }
  res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${total - 1}/${total}`, 'content-length': total - start });
  let from = start;
  if (seg) {
    const ok = res.write(seg.buf.subarray(start - seg.start));
    from = seg.start + seg.buf.length;
    if (from >= total) return res.end();
    if (!ok) await new Promise((r) => (res.once('drain', r), res.once('close', r)));
    if (res.destroyed) return;
  }
  const up = await upstream(kind, id, ext, from);
  const body = Readable.fromWeb(up.body);
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}

/* ---------------------------------------------------------- trabalhos */

const jobs = new Map();
const dirOf = (kind, id) => path.join(DIR, `${kind}-${id}`);

function have(kind, id) {
  try {
    return new Set(fs.readdirSync(dirOf(kind, id)).filter((f) => f.endsWith('.jpg')).map((f) => +f.slice(0, -4)));
  } catch {
    return new Set();
  }
}

function job(kind, id, ext) {
  const k = `${kind}/${id}`;
  let j = jobs.get(k);
  if (!j) {
    j = { kind, id, ext, focus: 0, dur: 0, done: have(kind, id), failed: new Map(), seen: Date.now(), hold: 0, running: false };
    fs.mkdirSync(dirOf(kind, id), { recursive: true });
    jobs.set(k, j);
    log('comecou', k, `${j.done.size} fotos ja prontas`);
  }
  j.seen = Date.now();
  if (ext) j.ext = ext;
  return j;
}

/** Proximo ponto: o que falta mais perto do foco (para tras vale um pouco mais, voltar e mais comum). */
function next(j) {
  const last = Math.floor((j.dur || 0) / STEP) * STEP;
  const f = Math.round(j.focus / STEP) * STEP;
  let best = null;
  let bestD = Infinity;
  for (let s = 0; s <= last; s += STEP) {
    if (j.done.has(s) || (j.failed.get(s) || 0) >= 2) continue;
    const d = s <= f ? f - s : (s - f) * 1.5;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function grab(j, sec) {
  return new Promise((resolveP) => {
    const out = path.join(dirOf(j.kind, j.id), `${sec}.jpg`);
    const tmp = `${out}.tmp.jpg`;
    const p = spawn(FFMPEG, ['-nostdin', '-loglevel', 'error', '-noaccurate_seek', '-ss', String(sec), '-i', `http://127.0.0.1:${PORT}/src/${j.kind}/${j.id}.${j.ext}`, '-frames:v', '1', '-vf', 'scale=320:-2,format=yuvj420p', '-q:v', '6', '-y', tmp]);
    const timer = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.on('close', () => {
      clearTimeout(timer);
      let ok = false;
      try {
        ok = fs.statSync(tmp).size > 500;
        if (ok) fs.renameSync(tmp, out);
        else fs.rmSync(tmp, { force: true });
      } catch {}
      resolveP(ok);
    });
  });
}

/** Um ffmpeg por vez: a lista so permite 2 conexoes e a TV usa uma. */
async function loop() {
  for (;;) {
    for (const [k, j] of jobs) if (Date.now() - j.seen > 3 * 60000) (jobs.delete(k), log('parou (sem sinal da TV)', k));
    const j = [...jobs.values()].sort((a, b) => b.seen - a.seen).find((x) => x.dur && Date.now() > x.hold);
    const sec = j && next(j);
    if (sec == null) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const t0 = Date.now();
    if (await grab(j, sec)) j.done.add(sec);
    else j.failed.set(sec, (j.failed.get(sec) || 0) + 1);
    if (j.done.size % 50 === 0) log(`${j.kind}/${j.id}: ${j.done.size} fotos (${Date.now() - t0} ms a ultima)`);
  }
}

/* ------------------------------------- lista e progresso compartilhados */

// A TV e o Mac mandam tudo o que tem; aqui junta item a item (vale o mais
// recente) e devolve o resultado para os dois ficarem iguais.
const STATE = path.join(APP_DIR, 'state.json');
let shared = null;
const loadShared = () => {
  if (!shared) {
    try {
      shared = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    } catch {
      shared = {};
    }
  }
  return shared;
};

function mergeState(a = {}, b = {}) {
  const cleared = Math.max(a.cleared || 0, b.cleared || 0);
  const newest = (x = {}, y = {}) => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) if (!out[k] || (v?.t || 0) > (out[k]?.t || 0)) out[k] = v;
    return out;
  };
  const gone = { ...(a.gone || {}) };
  for (const [k, t] of Object.entries(b.gone || {})) gone[k] = Math.max(gone[k] || 0, t);
  const progress = newest(a.progress, b.progress);
  for (const k of Object.keys(progress)) if ((progress[k]?.t || 0) <= cleared) delete progress[k];
  const hist = new Map();
  for (const h of [...(a.history || []), ...(b.history || [])]) {
    if (!h?.key || h.t <= cleared || (gone[h.key] || 0) >= h.t) continue;
    if (!hist.has(h.key) || h.t > hist.get(h.key).t) hist.set(h.key, h);
  }
  const history = [...hist.values()].sort((x, y) => y.t - x.t).slice(0, 200);
  return { progress, history, list: newest(a.list, b.list), gone, cleared };
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8e6) req.destroy(new Error('grande demais'));
      else parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

/* --------------------------------------------------------------- rede */

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    res.setHeader('access-control-allow-origin', '*');
    try {
      let m;
      if (u.pathname === '/ping') return res.end('ok');
      if (u.pathname === '/state') {
        res.setHeader('access-control-allow-headers', 'content-type');
        if (req.method === 'OPTIONS') return res.writeHead(204).end();
        if (req.method === 'POST') {
          const { state, adopt } = JSON.parse((await readBody(req)) || '{}');
          if (!adopt && state) {
            shared = mergeState(loadShared(), state);
            fs.writeFileSync(STATE + '.tmp', JSON.stringify(shared));
            fs.renameSync(STATE + '.tmp', STATE);
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(mergeState(loadShared(), {})));
      }
      if ((m = u.pathname.match(/^\/src\/(movie|series)\/(\d+)\.(\w+)$/))) {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.writeHead(403).end();
        return await source(req, res, m[1], m[2], m[3]);
      }
      if (u.pathname === '/watch' && /^(movie|series)$/.test(q.kind) && /^\d+$/.test(q.id)) {
        const j = job(q.kind, q.id, /^\w+$/.test(q.ext || '') ? q.ext : 'mp4');
        if (q.at) j.focus = +q.at || 0;
        if (+q.dur > 0) j.dur = +q.dur;
        if (+q.hold > 0) j.hold = Date.now() + +q.hold * 1000;
        return res.end(JSON.stringify({ step: STEP, have: j.done.size }));
      }
      // Foto pelo endereco direto (a TV mostra num <img>): /frame/<kind>/<id>/<seg>.jpg
      if ((m = u.pathname.match(/^\/frame\/(movie|series)\/(\d+)\/(\d+)\.jpg$/))) {
        const fp = path.join(dirOf(m[1], m[2]), `${+m[3]}.jpg`);
        if (!fs.existsSync(fp)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' });
        return fs.createReadStream(fp).pipe(res);
      }
      if ((m = u.pathname.match(/^\/(thumb|near)\/(movie|series)\/(\d+)\/(\d+)(\.jpg)?$/))) {
        m = [m[0], m[2], m[3], m[4], m[1]];
        const sec = +m[3];
        const j = jobs.get(`${m[1]}/${m[2]}`);
        if (j) {
          j.focus = sec;
          j.seen = Date.now();
        }
        const done = j ? j.done : have(m[1], m[2]);
        let best = null;
        for (const s of done) if (Math.abs(s - sec) <= 30 && (best == null || Math.abs(s - sec) < Math.abs(best - sec))) best = s;
        if (best == null) return res.writeHead(404).end();
        // /near: so diz qual foto e a mais proxima (a TV carrega pelo /frame).
        if (m[4] === 'near') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: best }));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400', 'x-thumb-at': String(best), 'access-control-expose-headers': 'x-thumb-at' });
        return fs.createReadStream(path.join(dirOf(m[1], m[2]), `${best}.jpg`)).pipe(res);
      }
      if (u.pathname === '/stop') {
        if (jobs.delete(`${q.kind}/${q.id}`)) log('parou', `${q.kind}/${q.id}`);
        return res.end('ok');
      }
      res.writeHead(404).end();
    } catch (err) {
      log('erro', req.url.replace(/\/src\/.*/, '/src/…'), err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })
  .listen(PORT, '0.0.0.0', () => log(`ajudante de miniaturas na porta ${PORT} (ffmpeg: ${FFMPEG})`));

fs.mkdirSync(DIR, { recursive: true });
loop();
