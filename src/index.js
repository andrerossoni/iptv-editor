/**
 * IPTV Editor - Cloudflare Worker
 *
 * Serve uma playlist Xtream/M3U editada a partir de blobs pre-renderizados no KV.
 * O trabalho pesado (montar categorias, aplicar renomeacoes, gerar o M3U) acontece
 * no editor, dentro do navegador. Aqui so lemos o KV e devolvemos o stream, para
 * ficar bem abaixo do limite de CPU do plano gratuito.
 */

const JSON_HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

const UA = 'VLC/3.0.20 LibVLC/3.0.20';

/* ------------------------------------------------------------------ utils */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'cache-control': 'no-store', ...extra },
  });
}

/** Comparacao de string em tempo constante, para nao vazar a senha por timing. */
function safeEqual(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function upstreamBase(env) {
  const scheme = env.XTREAM_SCHEME || 'https';
  return `${scheme}://${env.XTREAM_HOST}`;
}

/** Monta a URL equivalente no provedor real, trocando as credenciais. */
function upstreamUrl(env, path, params) {
  const url = new URL(upstreamBase(env) + path);
  if (params) {
    for (const [k, v] of params) url.searchParams.set(k, v);
    url.searchParams.set('username', env.XTREAM_USER);
    url.searchParams.set('password', env.XTREAM_PASS);
  }
  return url.toString();
}

/** Confere as credenciais que o player envia (as suas, nao as do provedor). */
function playlistAuth(env, url) {
  const u = url.searchParams.get('username');
  const p = url.searchParams.get('password');
  return safeEqual(u, env.PLAYLIST_USER) && safeEqual(p, env.PLAYLIST_PASS);
}

function adminAuth(env, request) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return env.ADMIN_PASSWORD && safeEqual(token, env.ADMIN_PASSWORD);
}

/** Le um blob publicado e devolve como stream, sem parsear (CPU ~ 0). */
async function serveBlob(env, key, contentType, fallback) {
  const stream = await env.IPTV.get(key, { type: 'stream', cacheTtl: 300 });
  if (!stream) {
    if (fallback === undefined) return json([], 200);
    return new Response(fallback, { headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
  }
  return new Response(stream, {
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/** Repassa a chamada ao provedor (usado em detalhes de filme/serie e EPG). */
async function passthrough(env, path, url) {
  const target = upstreamUrl(env, path, url.searchParams);
  const res = await fetch(target, { headers: { 'user-agent': UA }, cf: { cacheTtl: 60, cacheEverything: false } });
  const headers = new Headers();
  const ct = res.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  headers.set('access-control-allow-origin', '*');
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

/* ------------------------------------------------- player_api (modo Xtream) */

function userInfo(env, url) {
  const host = url.hostname;
  return {
    user_info: {
      username: env.PLAYLIST_USER,
      password: env.PLAYLIST_PASS,
      message: 'IPTV Editor',
      auth: 1,
      status: 'Active',
      exp_date: env.EXP_DATE || '2145916800',
      is_trial: '0',
      active_cons: '0',
      created_at: '1700000000',
      max_connections: env.MAX_CONNECTIONS || '2',
      allowed_output_formats: ['ts', 'm3u8', 'rtmp'],
    },
    server_info: {
      xui: true,
      version: '1.5.5',
      revision: 2,
      url: host,
      port: '80',
      https_port: '443',
      server_protocol: 'https',
      rtmp_port: '8880',
      timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString().replace('T', ' ').slice(0, 19),
      timezone: env.TIMEZONE || 'America/Sao_Paulo',
    },
  };
}

const CATEGORY_ACTIONS = {
  get_live_categories: 'pub:cat:live',
  get_vod_categories: 'pub:cat:vod',
  get_series_categories: 'pub:cat:series',
};

const STREAM_ACTIONS = {
  get_live_streams: 'live',
  get_vod_streams: 'vod',
  get_series: 'series',
};

/** Detalhes vem do provedor; so o nome recebe o seu override, se houver. */
async function serveDetails(env, url, path, kind, idParam) {
  const res = await passthrough(env, path, url);
  const id = url.searchParams.get(idParam);
  if (!id || !res.ok) return res;

  const overrides = await env.IPTV.get(`pub:names:${kind}`, { type: 'json', cacheTtl: 300 });
  const name = overrides && overrides[id];
  if (!name) return res;

  try {
    const data = await res.json();
    if (data && data.info && typeof data.info === 'object' && !Array.isArray(data.info)) {
      data.info.name = name;
      if (data.info.title) data.info.title = name;
    }
    if (data && data.movie_data && typeof data.movie_data === 'object') {
      data.movie_data.name = name;
    }
    return json(data);
  } catch {
    return res;
  }
}

async function handlePlayerApi(env, url) {
  if (!playlistAuth(env, url)) return json({ user_info: { auth: 0 } }, 401);

  const action = url.searchParams.get('action') || '';
  if (!action) return json(userInfo(env, url));

  if (CATEGORY_ACTIONS[action]) {
    return serveBlob(env, CATEGORY_ACTIONS[action], 'application/json;charset=UTF-8', '[]');
  }

  if (STREAM_ACTIONS[action]) {
    const kind = STREAM_ACTIONS[action];
    const cat = url.searchParams.get('category_id');
    // Ha um blob por categoria; assim o Worker nunca precisa filtrar nada.
    const key = cat ? `pub:st:${kind}:${cat}` : `pub:st:${kind}`;
    return serveBlob(env, key, 'application/json;charset=UTF-8', '[]');
  }

  if (action === 'get_series_info') {
    return serveDetails(env, url, '/player_api.php', 'series', 'series_id');
  }
  if (action === 'get_vod_info') {
    return serveDetails(env, url, '/player_api.php', 'vod', 'vod_id');
  }

  // get_short_epg, get_simple_data_table e o que mais o player pedir.
  return passthrough(env, '/player_api.php', url);
}

/* ------------------------------------------------------------- M3U (get.php) */

/**
 * O M3U pode passar de 100 MB quando inclui episodios, entao ele fica
 * dividido em pedacos no KV e e remontado aqui em streaming.
 */
async function handleGetPhp(env, url) {
  if (!playlistAuth(env, url)) return text('Credenciais invalidas', 401);

  const meta = await env.IPTV.get('pub:meta', { type: 'json', cacheTtl: 60 });
  const chunks = (meta && meta.m3uChunks) || 0;

  if (!chunks) {
    return text('#EXTM3U\n# Nenhuma lista publicada ainda. Abra /admin e clique em Publicar.\n', 200, {
      'content-type': 'application/vnd.apple.mpegurl;charset=UTF-8',
    });
  }

  const kv = env.IPTV;
  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (index >= chunks) {
        controller.close();
        return;
      }
      const part = await kv.get(`pub:m3u:${index}`, { type: 'arrayBuffer', cacheTtl: 300 });
      index++;
      if (part) controller.enqueue(new Uint8Array(part));
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/vnd.apple.mpegurl;charset=UTF-8',
      'content-disposition': 'inline; filename="playlist.m3u"',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/* ------------------------------------------------------- redirect de streams */

/**
 * O player pede /live/SEU_USER/SUA_SENHA/123.ts e nos respondemos 302 para o
 * provedor com as credenciais reais. Nenhum video passa pelo Worker.
 */
function redirectStream(env, kind, user, pass, file) {
  if (!safeEqual(user, env.PLAYLIST_USER) || !safeEqual(pass, env.PLAYLIST_PASS)) {
    return text('Credenciais invalidas', 401);
  }
  const target = `${upstreamBase(env)}/${kind}/${encodeURIComponent(env.XTREAM_USER)}/${encodeURIComponent(env.XTREAM_PASS)}/${file}`;
  return Response.redirect(target, 302);
}

/* ---------------------------------------------------------------- admin API */

async function handleAdminApi(env, request, url) {
  const path = url.pathname.replace(/^\/api\/admin/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      },
    });
  }

  if (path === '/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD) return json({ ok: false, error: 'ADMIN_PASSWORD nao configurada' }, 500);
    if (!safeEqual(body.password, env.ADMIN_PASSWORD)) return json({ ok: false, error: 'Senha incorreta' }, 401);
    return json({ ok: true, token: env.ADMIN_PASSWORD });
  }

  if (!adminAuth(env, request)) return json({ ok: false, error: 'Nao autorizado' }, 401);

  // Dados para montar o link que voce cola no player.
  if (path === '/info') {
    const meta = await env.IPTV.get('pub:meta', { type: 'json' });
    return json({
      ok: true,
      base: `${url.protocol}//${url.host}`,
      playlistUser: env.PLAYLIST_USER,
      playlistPass: env.PLAYLIST_PASS,
      upstreamHost: env.XTREAM_HOST,
      meta: meta || null,
    });
  }

  // Proxy do provedor: o navegador nao alcanca o servidor Xtream por causa do CORS.
  if (path === '/upstream') {
    const action = url.searchParams.get('action') || '';
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    for (const k of ['category_id', 'series_id', 'vod_id', 'stream_id']) {
      const v = url.searchParams.get(k);
      if (v) params.set(k, v);
    }
    const target = upstreamUrl(env, '/player_api.php', params);
    const res = await fetch(target, { headers: { 'user-agent': UA } });
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
    });
  }

  // M3U bruto do provedor, usado para reagrupar os episodios de serie.
  if (path === '/upstream-m3u') {
    const params = new URLSearchParams({ type: 'm3u_plus', output: 'mpegts' });
    const target = upstreamUrl(env, '/get.php', params);
    const res = await fetch(target, { headers: { 'user-agent': UA } });
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'cache-control': 'no-store' },
    });
  }

  // Estado do editor (suas pastas, renomeacoes e movimentacoes).
  if (path === '/state') {
    if (request.method === 'GET') {
      const state = await env.IPTV.get('state', { type: 'stream' });
      if (!state) return json({ ok: true, state: null });
      return new Response(state, { headers: JSON_HEADERS });
    }
    if (request.method === 'PUT') {
      await env.IPTV.put('state', request.body);
      return json({ ok: true });
    }
  }

  // Gravacao dos blobs ja prontos, vindos do editor.
  if (path === '/pub' && request.method === 'PUT') {
    const key = url.searchParams.get('key');
    if (!key || !/^[a-zA-Z0-9:_.\-]{1,400}$/.test(key)) return json({ ok: false, error: 'chave invalida' }, 400);
    await env.IPTV.put(`pub:${key}`, request.body);
    return json({ ok: true, key });
  }

  if (path === '/pub' && request.method === 'DELETE') {
    const prefix = url.searchParams.get('prefix') || '';
    if (!prefix) return json({ ok: false, error: 'prefixo obrigatorio' }, 400);
    const list = await env.IPTV.list({ prefix: `pub:${prefix}` });
    await Promise.all(list.keys.map((k) => env.IPTV.delete(k.name)));
    return json({ ok: true, deleted: list.keys.length, truncated: !list.list_complete });
  }

  return json({ ok: false, error: 'rota desconhecida' }, 404);
}

/* -------------------------------------------------------------- roteamento */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!env.XTREAM_HOST) {
      return text('Worker sem configuracao. Defina os secrets (veja o README).', 500);
    }

    // --- editor -------------------------------------------------------------
    if (path.startsWith('/api/admin')) return handleAdminApi(env, request, url);

    if (path === '/admin' || path === '/admin/') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    if (path.startsWith('/admin/')) {
      const asset = path.replace(/^\/admin/, '');
      return env.ASSETS.fetch(new Request(new URL(asset, url), request));
    }

    // --- playlist -----------------------------------------------------------
    if (path === '/player_api.php') return handlePlayerApi(env, url);
    if (path === '/panel_api.php') {
      if (!playlistAuth(env, url)) return json({ user_info: { auth: 0 } }, 401);
      return json(userInfo(env, url));
    }
    if (path === '/get.php' || path === '/playlist.m3u' || path === '/playlist') {
      return handleGetPhp(env, url);
    }
    if (path === '/xmltv.php' || path === '/epg.php') {
      if (!playlistAuth(env, url)) return text('Credenciais invalidas', 401);
      return passthrough(env, '/xmltv.php', url);
    }

    // --- video: sempre 302, o Worker nunca serve o video -------------------
    let m = path.match(/^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) return redirectStream(env, m[1], decodeURIComponent(m[2]), decodeURIComponent(m[3]), m[4]);

    // Formato antigo de canal ao vivo: /USER/PASS/123
    m = path.match(/^\/([^/]+)\/([^/]+)\/(\d+)$/);
    if (m) return redirectStream(env, 'live', decodeURIComponent(m[1]), decodeURIComponent(m[2]), `${m[3]}.ts`);

    // Tokens opacos do provedor (/play/... e /hlsr/...) seguem direto.
    if (/^\/(play|hlsr|timeshift|streaming)\//.test(path)) {
      return Response.redirect(upstreamBase(env) + path + url.search, 302);
    }

    // arquivos do editor (o HTML os pede na raiz)
    if (/^\/(app\.js|app\.css|index\.html|favicon\.ico)$/.test(path)) {
      return env.ASSETS.fetch(request);
    }

    if (path === '/') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>IPTV Editor</title>' +
          '<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">' +
          '<h1>IPTV Editor</h1><p>Servidor no ar.</p>' +
          '<p><a href="/admin">Abrir o editor &rarr;</a></p></body>',
        { headers: { 'content-type': 'text/html;charset=UTF-8' } }
      );
    }

    return text('Nao encontrado', 404);
  },
};
