/**
 * Monta o app da TV em tizen/build/: as mesmas telas do Mac, mais o adaptador
 * da TV (native-tizen.js), o controle remoto (tv.js) e os seus dados de acesso.
 *
 *   node tizen/build.js
 *
 * Os dados (servidor, usuario, senha, chave do TMDB) vem da configuracao do app
 * do Mac e entram so no pacote local — a pasta build/ fica fora do git.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to = path.basename(from)) => fs.copyFileSync(from, path.join(out, to));
for (const f of fs.readdirSync(path.join(root, 'renderer'))) if (f !== 'index.html') copy(path.join(root, 'renderer', f));
for (const f of ['config.xml', 'icon.png', 'native-tizen.js', 'avplay-video.js', 'tv.js', 'live.js', 'tv.css']) copy(path.join(__dirname, f));

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/IPTV Cinema/config.json'), 'utf8'));
} catch {
  console.warn('Sem configuracao do app do Mac: informe servidor e usuario nos Ajustes da TV.');
}
const defaults = { server: cfg.server || '', user: cfg.user || '', pass: cfg.pass || '', tmdbKey: cfg.tmdbKey || '' };
fs.writeFileSync(path.join(out, 'defaults.js'), `window.IPTV_DEFAULTS = ${JSON.stringify(defaults)};\n`);

let html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
html = html
  // Na TV o video vai pelo AVPlay (player nativo), que ja toca HLS: sem hls.js.
  .replace('<script src="../node_modules/hls.js/dist/hls.min.js"></script>', '<script src="$WEBAPIS/webapis/webapis.js"></script>')
  .replace('<link rel="stylesheet" href="style.css" />', '<link rel="stylesheet" href="style.css" />\n    <link rel="stylesheet" href="tv.css" />')
  .replace('<script src="util.js"></script>', '<script src="defaults.js"></script>\n    <script src="native-tizen.js"></script>\n    <script src="util.js"></script>')
  .replace('<script src="player.js"></script>', '<script src="avplay-video.js"></script>\n    <script src="player.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="app.js"></script>\n    <script src="tv.js"></script>\n    <script src="live.js"></script>');
if (!html.includes('tv.js') || !html.includes('native-tizen.js') || !html.includes('webapis.js') || !html.includes('avplay-video.js')) throw new Error('index.html mudou: ajuste o build.js');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('Pronto:', out);
