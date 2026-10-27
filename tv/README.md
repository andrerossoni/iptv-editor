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

## Versão para TV Samsung (Tizen)

As mesmas telas, com controle remoto, player nativo da Samsung (AVPlay) e um
ao vivo próprio para a TV (lista única de canais, troca por CH+/CH-, barra de
programação na seta para baixo e lista de canais no OK). Fica em `tizen/`.

Pré-requisitos (uma vez só):

1. Tizen Studio CLI em `~/tizen-studio`, com o Certificate Manager e o
   `cert-add-on` (certificado Samsung).
2. Perfil de certificado **IPTVCinema** (tipo Samsung → TV) criado no
   Certificate Manager. Vale até 27/10/2027; depois é só criar outro e reinstalar.
3. TV em Modo Desenvolvedor com o IP do Mac (Aplicativos → 12345).

Instalar ou atualizar na TV:

    sh tizen/deploy.sh 192.168.1.12

O pacote leva servidor, usuário, senha e chave do TMDB tirados da configuração
do app do Mac — por isso `tizen/build/` e o `.wgt` ficam fora do git.
