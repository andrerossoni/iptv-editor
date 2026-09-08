# IPTV Editor

Editor de listas IPTV que entrega um **link que funciona de verdade** no seu player.

Você organiza a lista do seu provedor — Ao Vivo, Filmes e Séries, cada uma com as
suas subpastas — arrastando, renomeando e movendo em massa. No fim, publica e recebe
um link Xtream + M3U pronto para colar no player.

Roda de graça no Cloudflare Workers. As suas credenciais do provedor ficam guardadas
como *secret* na sua conta, nunca no código.

---

## Por que os outros editores entregam link quebrado

Quase todo site de edição gera só um arquivo `.m3u` estático.

Quando você adiciona esse link no player em **modo Xtream**, o player não lê o arquivo:
ele chama `player_api.php` pedindo as categorias, os filmes e as séries. Como esse
endereço não existe naquele link, o player não recebe nada e a lista aparece vazia.

Este projeto sobe um servidor que responde às duas coisas:

| O player pede | Este projeto responde |
|---|---|
| `player_api.php` (modo Xtream) | categorias, canais, filmes, séries, temporadas e episódios |
| `get.php` (modo M3U) | a playlist completa |
| `xmltv.php` | o guia de programação (EPG) |
| `/live/…`, `/movie/…`, `/series/…` | redireciona para o servidor do provedor |

O vídeo nunca passa pelo Worker — ele apenas responde "o vídeo está ali" (redirect 302).
Isso mantém a qualidade, não gasta banda e não consome uma conexão extra do seu plano.

---

## Instalação — o jeito fácil

Você não precisa entender de programação. Faça assim:

1. Baixe o projeto (botão verde **Code** → **Download ZIP**) e descompacte.
2. Se ainda não tiver o **Node.js**, baixe em [nodejs.org](https://nodejs.org) —
   clique no botão verde da esquerda e instale normalmente, apertando "Continuar".
3. Abra a pasta do projeto e dê **dois cliques** no arquivo **`instalar.command`**.

> Se o Mac disser que "não pode ser aberto porque é de um desenvolvedor não
> identificado": clique com o **botão direito** no arquivo, escolha **Abrir**,
> e depois **Abrir** de novo na janela que aparecer.

O instalador conversa com você em português e faz o resto sozinho: cria a conta na
Cloudflare, pergunta o link do seu provedor e publica tudo. Leva uns 5 minutos.

No fim ele salva um arquivo **`MEUS-DADOS.txt`** com o seu link e as suas senhas.

---

## Instalação — passo a passo manual

Só se você preferir digitar os comandos você mesmo.

Precisa de [Node.js](https://nodejs.org) instalado e de uma conta gratuita na
[Cloudflare](https://dash.cloudflare.com/sign-up). Não precisa de cartão de crédito.

### 1. Baixe o projeto e instale

```bash
git clone https://github.com/SEU-USUARIO/iptv-editor.git
cd iptv-editor
npm install
```

### 2. Entre na sua conta Cloudflare

```bash
npx wrangler login
```

Abre o navegador para você autorizar. É uma vez só.

### 3. Crie o banco de dados (KV)

```bash
npx wrangler kv namespace create IPTV
```

O comando devolve algo assim:

```
[[kv_namespaces]]
binding = "IPTV"
id = "a1b2c3d4e5f6..."
```

Copie esse `id` e cole no `wrangler.toml`, no lugar de `COLE_AQUI_O_ID_DO_KV`.

### 4. Guarde as suas credenciais

Cada comando abaixo pergunta o valor e o guarda criptografado na Cloudflare.
**Nada disso vai para o GitHub.**

```bash
npx wrangler secret put XTREAM_HOST
npx wrangler secret put XTREAM_USER
npx wrangler secret put XTREAM_PASS
npx wrangler secret put PLAYLIST_USER
npx wrangler secret put PLAYLIST_PASS
npx wrangler secret put ADMIN_PASSWORD
```

O que responder em cada um:

| Secret | O que colocar |
|---|---|
| `XTREAM_HOST` | o servidor do provedor, só o domínio: `servidor.com` (sem `http://`, sem `/get.php`) |
| `XTREAM_USER` | o `username` do link que o provedor te deu |
| `XTREAM_PASS` | o `password` do mesmo link |
| `PLAYLIST_USER` | **você inventa.** É o usuário que você vai digitar no player |
| `PLAYLIST_PASS` | **você inventa.** É a senha que você vai digitar no player |
| `ADMIN_PASSWORD` | **você inventa.** Protege o editor em `/admin` |

> **Como achar o host, o usuário e a senha no seu link**
> Se o provedor te deu
> `http://servidor.com/get.php?username=12345&password=67890&type=m3u_plus`
> então: `XTREAM_HOST` = `servidor.com`, `XTREAM_USER` = `12345`, `XTREAM_PASS` = `67890`.

Se o servidor do seu provedor não aceitar HTTPS, mude no `wrangler.toml`:
`XTREAM_SCHEME = "http"`.

### 5. Publique

```bash
npm run deploy
```

No fim aparece o seu endereço, algo como `https://iptv-editor.SEU-NOME.workers.dev`.

---

## Usando

1. Abra `https://SEU-ENDEREÇO.workers.dev/admin` e entre com a `ADMIN_PASSWORD`.
2. Clique em **↻ Sincronizar**. Ele baixa o catálogo do provedor (leva alguns segundos).
3. Edite à vontade (veja abaixo).
4. Clique em **Publicar**.
5. Clique em **🔗 Meu link** e configure o seu player.

Toda vez que editar algo, clique em **Publicar** de novo. O link é sempre o mesmo.

### Configurando no player

**Modo Xtream** — recomendado, é o que faz as séries aparecerem com temporadas
e episódios separados. Funciona no TiviMate, IPTV Smarters, XCIPTV, OTT Navigator
e na maioria das Smart TVs.

```
Servidor:  https://SEU-ENDEREÇO.workers.dev
Usuário:   o seu PLAYLIST_USER
Senha:     a sua PLAYLIST_PASS
```

**Modo M3U** — para players que só aceitam arquivo:

```
https://SEU-ENDEREÇO.workers.dev/get.php?username=USER&password=SENHA&type=m3u_plus&output=mpegts
```

**Guia de programação (EPG):**

```
https://SEU-ENDEREÇO.workers.dev/xmltv.php?username=USER&password=SENHA
```

---

## O que dá para editar

**Pastas** (coluna da esquerda)

- **+ Nova** cria uma pasta.
- **Duplo clique** renomeia.
- **Arraste** uma pasta para mudar a ordem em que ela aparece no player.
- **⋯** abre o menu de uma pasta só: renomear, ocultar, selecionar tudo, esvaziar ou excluir.
- Pasta **oculta** some da lista publicada, mas continua aqui para você reverter depois.

**Várias pastas de uma vez**

Marque a caixinha ao lado de cada pasta. **Shift+clique** pega um intervalo inteiro,
e a caixinha no topo marca todas que estiverem à vista (respeitando o filtro de busca).
Com pastas marcadas aparece esta barra:

| Botão | O que faz |
|---|---|
| **🚫 Ocultar** / **👁 Mostrar** | tira ou devolve as pastas da lista publicada |
| **✏️ Renomear** | localizar/substituir, prefixo e sufixo em todos os nomes de uma vez |
| **🔗 Mesclar** | junta tudo numa pasta só — ideal para reunir GLOBO CAPITAL, SUDESTE, SUL… em um "GLOBO" |
| **📤 Esvaziar em…** | manda o conteúdo para outra pasta, mantendo as pastas vazias |
| **⬆ Para o topo** | leva as pastas selecionadas para o começo da lista |
| **🗑 Excluir** | remove as pastas; o conteúdo vai para "Sem pasta" e nada é perdido |

Arrastar uma pasta marcada leva todas as marcadas junto.

**Itens** (lista da direita)

- **Clique** seleciona. **Shift+clique** seleciona um intervalo. **Cmd/Ctrl+clique**
  soma ou tira um item. **Cmd/Ctrl+A** seleciona tudo que está à vista.
- **Arraste** os itens selecionados para cima de uma pasta para movê-los.
- **Duplo clique** renomeia um item.
- Com itens selecionados aparece a barra de ações:
  - **Mover para…** joga tudo para outra pasta.
  - **Renomear em massa** faz localizar/substituir, com prefixo e sufixo. Aceita
    expressão regular e mostra uma prévia antes de aplicar.
  - **Ocultar** / **Mostrar** tira ou devolve itens da lista publicada.
  - **Restaurar original** desfaz as suas mudanças naqueles itens.

As suas edições ficam salvas na nuvem (salvamento automático a cada 30 segundos),
então dá para editar do Mac hoje e continuar do celular amanhã.

### Episódios de série no M3U

Em **🔗 Meu link** existe a opção *Incluir episódios de série no M3U*.

Deixe **desligada** se você usa o modo Xtream — lá as séries já funcionam melhor,
com temporadas separadas.

Ligada, a publicação passa a processar a lista inteira de episódios (mais de 100 MB,
vários minutos). Só vale a pena se o seu player não suportar Xtream. Os episódios
seguem automaticamente a pasta e o nome que você deu para a série.

---

## Segurança

- O código pode ficar num repositório **público** sem problema: ele não contém
  nenhuma credencial.
- As credenciais do provedor ficam como *secret* na sua conta Cloudflare.
- O `.gitignore` já bloqueia o `.dev.vars` (o arquivo de teste local).
- O link que você usa no player leva o `PLAYLIST_USER`/`PLAYLIST_PASS` que **você**
  inventou — quem receber esse link não descobre os dados do seu provedor.
- Trate o link publicado como uma senha: quem tiver ele assiste à sua lista.

Para trocar as credenciais depois, rode `npx wrangler secret put NOME` de novo
e `npm run deploy`.

---

## Limites do plano gratuito

| Recurso | Limite gratuito | Uso típico aqui |
|---|---|---|
| Requisições ao Worker | 100.000/dia | um player gasta algumas centenas por dia |
| Escritas no KV | 1.000/dia | cada **Publicar** usa cerca de 150 |
| Leituras no KV | 100.000/dia | folgado |
| Armazenamento KV | 1 GB | a lista completa ocupa bem menos |

Publicar umas 5 vezes por dia fica tranquilo dentro do limite.

---

## Rodando na sua máquina (opcional)

```bash
cp .dev.vars.example .dev.vars   # preencha com os seus dados
npm run dev
```

Abre em `http://localhost:8787/admin`. O KV é simulado localmente, separado do
que está publicado.

---

## Problemas comuns

**A lista aparece vazia no player**
Você já clicou em **Publicar**? Sincronizar só baixa; publicar é o que gera o link.

**"Credenciais inválidas"**
O usuário/senha do player têm que ser exatamente o `PLAYLIST_USER`/`PLAYLIST_PASS`,
não os do provedor.

**Sincronizar falha**
Confira o `XTREAM_HOST` (só o domínio) e teste `XTREAM_SCHEME = "http"` no
`wrangler.toml` se o provedor não tiver HTTPS.

**Canal não abre, mas aparece na lista**
Aí o problema é do provedor, não daqui — o link redireciona direto para ele.
Teste o mesmo canal na lista original.

**As mudanças não aparecem no player**
Publique e force o "atualizar lista" no player. Alguns guardam cache por horas.

**Ver os logs do servidor**

```bash
npm run logs
```

---

## Como funciona por dentro

O trabalho pesado acontece no navegador, não no servidor. O editor monta os arquivos
finais (as respostas da API Xtream e o M3U) e envia prontos para o Worker guardar.
Quando o player pede alguma coisa, o Worker só lê e devolve — sem processar nada.

É isso que mantém tudo dentro do limite de CPU do plano gratuito, mesmo com uma lista
de quase 40 mil itens.

```
Provedor Xtream
      │  (o editor baixa o catálogo uma vez)
      ▼
Editor no navegador ──► arquivos prontos ──► KV da Cloudflare
                                                  │
                              player pede ────────┘
                                    │
                              Worker devolve
                                    │
                       vídeo ──► redirect para o provedor
```

## Licença

MIT — use como quiser.
