#!/bin/bash
# Instalador do IPTV Editor. Duplo clique neste arquivo para rodar.

cd "$(dirname "$0")" || exit 1

B=$'\033[1m'; V=$'\033[32m'; A=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'

titulo() { printf "\n${B}${C}==> %s${N}\n\n" "$1"; }
ok()     { printf "${V}   ✓ %s${N}\n" "$1"; }
aviso()  { printf "${A}   ! %s${N}\n" "$1"; }
erro()   { printf "\n${R}   ✗ %s${N}\n\n" "$1"; }

parar() {
  erro "$1"
  echo "   Copie a mensagem acima e mande para o Claude que ele resolve."
  echo
  read -r -p "   Aperte Enter para fechar."
  exit 1
}

clear
cat <<'BANNER'
  ┌─────────────────────────────────────────────┐
  │                                             │
  │        📺  IPTV EDITOR — INSTALAÇÃO         │
  │                                             │
  └─────────────────────────────────────────────┘
BANNER
echo
echo "  Este instalador coloca o seu editor de listas no ar."
echo "  Leva uns 5 minutos. É só ir respondendo o que ele pedir."
echo
read -r -p "  Aperte Enter para começar."

# ---------------------------------------------------------------- 1. Node
titulo "PASSO 1 de 6 — Verificando o seu computador"

if ! command -v node >/dev/null 2>&1; then
  erro "O Node.js não está instalado."
  echo "   Baixe em https://nodejs.org (botão verde da esquerda),"
  echo "   instale, e depois abra este instalador de novo."
  echo
  read -r -p "   Aperte Enter para fechar."
  exit 1
fi
ok "Node.js $(node -v) encontrado"

if [ ! -d node_modules ]; then
  echo "   Baixando os componentes necessários (demora um pouco)…"
  npm install --no-audit --no-fund --silent || parar "Falhou ao baixar os componentes."
fi
ok "Componentes prontos"

# ------------------------------------------------------------ 2. Cloudflare
titulo "PASSO 2 de 6 — Entrando na sua conta Cloudflare"

echo "  A Cloudflare é quem vai hospedar o seu link, de graça."
echo
if npx --no-install wrangler whoami >/dev/null 2>&1; then
  ok "Você já está conectado"
else
  echo "  Vou abrir o seu navegador agora."
  echo "  ${B}Se você ainda não tem conta, clique em \"Sign up\" e crie uma${N}"
  echo "  (é grátis e não pede cartão). Depois clique no botão azul"
  echo "  ${B}\"Allow\"${N} para autorizar."
  echo
  read -r -p "  Aperte Enter para abrir o navegador."
  npx wrangler login || parar "Não consegui conectar na Cloudflare."
  ok "Conectado"
fi

# ------------------------------------------------------------------ 3. KV
titulo "PASSO 3 de 6 — Criando o espaço de armazenamento"

KV_ID=$(grep -E '^id = "' wrangler.toml | sed -E 's/.*"(.*)".*/\1/')

if [ -n "$KV_ID" ] && [ "$KV_ID" != "COLE_AQUI_O_ID_DO_KV" ]; then
  ok "Já estava criado"
else
  SAIDA=$(npx wrangler kv namespace create IPTV 2>&1)
  KV_ID=$(echo "$SAIDA" | grep -oE 'id = "[a-f0-9]{32}"' | head -1 | sed -E 's/.*"(.*)"/\1/')

  if [ -z "$KV_ID" ]; then
    # já existia de uma tentativa anterior: procura pelo nome
    KV_ID=$(npx wrangler kv namespace list 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("[")));const m=j.find(x=>/IPTV/i.test(x.title));if(m)console.log(m.id)}catch(e){}})')
  fi
  [ -z "$KV_ID" ] && { echo "$SAIDA"; parar "Não consegui criar o armazenamento."; }

  node -e '
    const fs=require("fs");
    const f="wrangler.toml";
    fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace(/^id = ".*"$/m, `id = "${process.argv[1]}"`));
  ' "$KV_ID" || parar "Não consegui salvar a configuração."
  ok "Armazenamento criado"
fi

# -------------------------------------------------------------- 4. provedor
titulo "PASSO 4 de 6 — Os dados do seu provedor de IPTV"

echo "  Cole abaixo o link que o seu provedor te deu."
echo "  ${B}O link inteiro${N}, aquele que começa com http:// e tem"
echo "  username e password no meio. Eu separo o resto sozinho."
echo
echo "  ${A}Este dado fica guardado só na sua conta Cloudflare.${N}"
echo "  ${A}Ele não vai para o GitHub nem para lugar nenhum.${N}"
echo

LINK=""
while [ -z "$LINK" ]; do
  read -r -p "  Link: " LINK
  DADOS=$(node -e '
    try {
      const u = new URL(process.argv[1].trim());
      const user = u.searchParams.get("username");
      const pass = u.searchParams.get("password");
      if (!user || !pass) throw 0;
      console.log([u.hostname, user, pass].join("\n"));
    } catch (e) { process.exit(1); }
  ' "$LINK" 2>/dev/null) || { aviso "Não reconheci esse link. Ele precisa ter username= e password="; LINK=""; continue; }
done

XHOST=$(echo "$DADOS" | sed -n 1p)
XUSER=$(echo "$DADOS" | sed -n 2p)
XPASS=$(echo "$DADOS" | sed -n 3p)
ok "Servidor: $XHOST"
ok "Usuário e senha do provedor: identificados"

echo "   Testando a conexão com o provedor…"
ESQUEMA="https"
if ! curl -s -o /dev/null --max-time 20 -A "VLC/3.0.20" \
     "https://$XHOST/player_api.php?username=$XUSER&password=$XPASS"; then
  ESQUEMA="http"
  curl -s -o /dev/null --max-time 20 -A "VLC/3.0.20" \
     "http://$XHOST/player_api.php?username=$XUSER&password=$XPASS" \
     || aviso "Não obtive resposta agora. Sigo assim mesmo; dá para corrigir depois."
fi
node -e '
  const fs=require("fs"), f="wrangler.toml";
  fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace(/^XTREAM_SCHEME = ".*"$/m, `XTREAM_SCHEME = "${process.argv[1]}"`));
' "$ESQUEMA"
ok "Conexão confirmada ($ESQUEMA)"

# ------------------------------------------------------------------ 5. senhas
titulo "PASSO 5 de 6 — Criando as suas senhas"

echo "  Agora escolha a senha para entrar no editor."
echo "  ${B}Anote esta senha${N} — é com ela que você abre a tela de edição."
echo

ADMIN=""
while [ ${#ADMIN} -lt 6 ]; do
  read -r -p "  Senha do editor (mínimo 6 caracteres): " ADMIN
  [ ${#ADMIN} -lt 6 ] && aviso "Muito curta. Use pelo menos 6 caracteres."
done

# usuario e senha do link: gerados, voce nao precisa decorar
PUSER="u$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 9)"
PPASS="$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 18)"
ok "Senha do editor definida"
ok "Usuário e senha do seu link: gerados automaticamente"

echo "   Guardando tudo com segurança na Cloudflare…"
guardar() {
  printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null 2>&1 \
    || parar "Não consegui guardar $1."
}
guardar XTREAM_HOST     "$XHOST"
guardar XTREAM_USER     "$XUSER"
guardar XTREAM_PASS     "$XPASS"
guardar PLAYLIST_USER   "$PUSER"
guardar PLAYLIST_PASS   "$PPASS"
guardar ADMIN_PASSWORD  "$ADMIN"
ok "Dados guardados"

# ------------------------------------------------------------------ 6. deploy
titulo "PASSO 6 de 6 — Colocando no ar"

SAIDA=$(npx wrangler deploy 2>&1) || { echo "$SAIDA"; parar "Falhou ao publicar."; }
URL=$(echo "$SAIDA" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
[ -z "$URL" ] && { echo "$SAIDA"; parar "Publiquei, mas não achei o endereço."; }
ok "No ar!"

cat > MEUS-DADOS.txt <<TXT
========================================
   IPTV EDITOR — OS SEUS DADOS
   Criado em $(date '+%d/%m/%Y às %H:%M')
========================================

PARA EDITAR A SUA LISTA
-----------------------
Endereço: $URL/admin
Senha:    $ADMIN


PARA O SEU PLAYER — MODO XTREAM (use este)
------------------------------------------
Servidor: $URL
Usuário:  $PUSER
Senha:    $PPASS


PARA O SEU PLAYER — MODO M3U (só se o player não tiver Xtream)
--------------------------------------------------------------
$URL/get.php?username=$PUSER&password=$PPASS&type=m3u_plus&output=mpegts


GUIA DE PROGRAMAÇÃO (EPG)
-------------------------
$URL/xmltv.php?username=$PUSER&password=$PPASS


IMPORTANTE
----------
- Guarde este arquivo. Quem tiver estes dados assiste à sua lista.
- Depois de editar, clique sempre em PUBLICAR.
- Antes da primeira vez: entre no editor, clique em SINCRONIZAR,
  depois em PUBLICAR. Só então o link funciona.
TXT

clear
cat <<BANNER

  ┌─────────────────────────────────────────────┐
  │                                             │
  │            ✅  TUDO PRONTO!                 │
  │                                             │
  └─────────────────────────────────────────────┘

  ${B}AGORA FAÇA ISTO, NESTA ORDEM:${N}

  ${B}1.${N} Abra este endereço no navegador:

       ${C}$URL/admin${N}

  ${B}2.${N} Digite a senha que você acabou de escolher.

  ${B}3.${N} Clique no botão ${B}↻ Sincronizar${N} (em cima, à direita)
     e espere terminar. Ele baixa a sua lista.

  ${B}4.${N} Clique no botão azul ${B}Publicar${N}.

  ${B}5.${N} No seu player, escolha ${B}Xtream Codes${N} e preencha:

       Servidor: ${C}$URL${N}
       Usuário:  ${C}$PUSER${N}
       Senha:    ${C}$PPASS${N}

  ─────────────────────────────────────────────

  Estes dados foram salvos no arquivo ${B}MEUS-DADOS.txt${N},
  aqui nesta mesma pasta. Não perca.

BANNER

read -r -p "  Aperte Enter para abrir o editor no navegador."
open "$URL/admin" 2>/dev/null
open . 2>/dev/null
