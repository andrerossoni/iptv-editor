/**
 * IPTV Cinema — app de Mac que toca a lista publicada pelo IPTV Editor.
 *
 * O processo principal so cuida do que o navegador nao faz sozinho: guardar a
 * configuracao e o catalogo em disco, e falar com o TMDB (com cache), para a
 * chave nunca ficar exposta na pagina.
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TMDB_TTL = 7 * 24 * 3600 * 1000;

const dataDir = () => app.getPath('userData');
const configFile = () => path.join(dataDir(), 'config.json');
const cacheDir = (sub) => {
  const dir = path.join(dataDir(), 'cache', sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* ---------------------------------------------------------------- config */

/** O instalador do editor gera um MEUS-DADOS.txt com o link M3U; dele tiramos servidor, usuario e senha. */
function credsFromMeusDados() {
  const candidates = [
    path.join(__dirname, '..', 'MEUS-DADOS.txt'),
    path.join(app.getPath('documents'), 'iptv-editor', 'MEUS-DADOS.txt'),
  ];
  for (const file of candidates) {
    try {
      const match = fs.readFileSync(file, 'utf8').match(/https?:\/\/\S+\/get\.php\?\S+/);
      if (!match) continue;
      const u = new URL(match[0]);
      return { server: u.origin, user: u.searchParams.get('username'), pass: u.searchParams.get('password') };
    } catch {}
  }
  return {};
}

function readConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {}
  if (!cfg.server || !cfg.user || !cfg.pass) {
    cfg = { ...cfg, ...credsFromMeusDados() };
    if (cfg.server) writeConfig(cfg);
  }
  return cfg;
}

function writeConfig(cfg) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

/* ----------------------------------------------------------------- cache */

function cacheGet(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir('data'), `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function cacheSet(name, data) {
  fs.writeFileSync(path.join(cacheDir('data'), `${name}.json`), JSON.stringify(data));
}

/* ------------------------------------------------------------------ TMDB */

async function tmdb(apiPath, ttl = TMDB_TTL) {
  const key = (readConfig().tmdbKey || '').trim();
  if (!key) return null;

  const file = path.join(cacheDir('tmdb'), crypto.createHash('sha1').update(apiPath).digest('hex') + '.json');
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttl) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  // Aceita tanto a "chave da API" (v3) quanto o "token de leitura" (v4, comeca com eyJ).
  const isToken = key.startsWith('eyJ');
  const url = new URL('https://api.themoviedb.org/3' + apiPath);
  if (!isToken) url.searchParams.set('api_key', key);
  const res = await fetch(url, { headers: isToken ? { authorization: `Bearer ${key}` } : {} });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const data = await res.json();
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

/* ---------------------------------------------------------------- janela */

function createWindow() {
  // Para testes automaticos: janela invisivel, em tamanho fixo de TV.
  const headless = process.env.IPTV_CINEMA_HEADLESS === '1';
  const win = new BrowserWindow({
    width: headless ? 1920 : 1600,
    height: headless ? 1080 : 900,
    fullscreen: !headless,
    show: !headless,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0a0a0d',
    title: 'IPTV Cinema',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // O provedor entrega o video por http e sem CORS; como o app so roda
      // localmente e so abre a nossa propria pagina, desligamos essa trava.
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links externos (trailer, site do TMDB) abrem no navegador padrao.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, patch) => {
  const cfg = { ...readConfig(), ...patch };
  writeConfig(cfg);
  return cfg;
});
ipcMain.handle('cache:get', (_e, name) => cacheGet(name));
ipcMain.handle('cache:set', (_e, name, data) => cacheSet(name, data));
ipcMain.handle('tmdb', (_e, apiPath, ttl) => tmdb(apiPath, ttl));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('window:fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.handle('app:quit', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
