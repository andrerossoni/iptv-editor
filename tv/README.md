# IPTV Cinema

App de Mac, estilo Netflix, que toca a lista publicada pelo IPTV Editor.
Feito para a TV: letras grandes, botões grandes, controle por mouse remoto.

## Usar

O app fica em `~/Applications/IPTV Cinema.app`. Abra com dois cliques.

Na primeira vez ele lê o servidor, o usuário e a senha do `MEUS-DADOS.txt`.
Nada disso vai para o git — fica em `~/Library/Application Support/IPTV Cinema/`.

- **Voltar:** botão lateral do mouse, `Esc` ou a seta no canto.
- **Player:** espaço pausa, ← volta 10s, → avança 30s, `F` alterna tela cheia.
- **Ao vivo:** ↑ e ↓ trocam de canal.
- **Ajustes (engrenagem):** tamanho da tela e chave do TMDB.

## TMDB (opcional)

Com a chave gratuita do [TMDB](https://www.themoviedb.org/settings/api), o app
mostra fundos em alta resolução, logotipos, elenco e "títulos semelhantes".
Cole a chave (ou o token de leitura) em Ajustes.

## Desenvolver

```bash
cd tv
npm install
npm start        # roda sem empacotar
npm run build    # gera dist/IPTV Cinema-darwin-arm64/IPTV Cinema.app
```
