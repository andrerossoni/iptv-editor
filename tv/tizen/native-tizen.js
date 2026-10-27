/**
 * Na TV nao existe o processo do Electron: este arquivo faz o papel do
 * preload.js do Mac, com a mesma interface (window.native).
 *
 * Configuracao no localStorage; catalogo e respostas do TMDB no IndexedDB
 * (o catalogo passa de 10 MB, grande demais para o localStorage).
 */
(function () {
  const TMDB_TTL = 7 * 24 * 3600 * 1000;
  const DEFAULTS = window.IPTV_DEFAULTS || {};

  let dbPromise;
  const db = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('iptv-cinema', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  const idb = async (mode, fn) => {
    const store = (await db()).transaction('kv', mode).objectStore('kv');
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  const idbGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);
  const idbSet = (key, value) => idb('readwrite', (s) => s.put(value, key)).catch(() => {});

  const readConfig = () => {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('config') || '{}');
    } catch {}
    return { ...DEFAULTS, ...saved };
  };

  window.native = {
    async getConfig() {
      return readConfig();
    },

    async setConfig(patch) {
      const cfg = { ...readConfig(), ...patch };
      localStorage.setItem('config', JSON.stringify(cfg));
      return cfg;
    },

    async cacheGet(name) {
      const raw = await idbGet(`cache:${name}`);
      return raw ? JSON.parse(raw) : null;
    },

    async cacheSet(name, data) {
      await idbSet(`cache:${name}`, JSON.stringify(data));
    },

    async tmdb(apiPath, ttl = TMDB_TTL) {
      const key = (readConfig().tmdbKey || '').trim();
      if (!key) return null;
      const cached = await idbGet(`tmdb:${apiPath}`);
      if (cached && Date.now() - cached.t < ttl) return cached.d;

      const isToken = key.startsWith('eyJ');
      const url = new URL('https://api.themoviedb.org/3' + apiPath);
      if (!isToken) url.searchParams.set('api_key', key);
      const res = await fetch(url, { headers: isToken ? { authorization: `Bearer ${key}` } : {} });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`TMDB ${res.status}`);
      const d = await res.json();
      idbSet(`tmdb:${apiPath}`, { t: Date.now(), d });
      return d;
    },

    /** Trailer: abre o app do YouTube da TV. */
    async openExternal(url) {
      try {
        const control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
        tizen.application.launchAppControl(control, '111299001912', null, () => toast('Não consegui abrir o YouTube.'));
      } catch {
        toast('Não consegui abrir o YouTube.');
      }
    },

    async toggleFullscreen() {},

    async quit() {
      try {
        tizen.application.getCurrentApplication().exit();
      } catch {
        window.close();
      }
    },
  };
})();
