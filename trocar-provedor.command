#!/bin/bash
# Troca o provedor de IPTV sem perder as suas edicoes. Duplo clique neste arquivo.
#
# So muda o servidor, o usuario e a senha do PROVEDOR. O seu link (o que esta
# no player e no MEUS-DADOS.txt) continua o mesmo. Depois, no editor, o botao
# Sincronizar leva as suas pastas e nomes para os itens do provedor novo.

cd "$(dirname "$0")" || exit 1
B=$'\033[1m'; V=$'\033[32m'; A=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
ok()    { printf "${V}   ✓ %s${N}\n" "$1"; }
aviso() { printf "${A}   ! %s${N}\n" "$1"; }
parar() { printf "\n${R}   ✗ %s${N}\n\n" "$1"; read -r -p "   Aperte Enter para fechar."; exit 1; }

clear
echo
echo "  ${B}📺 IPTV EDITOR — TROCAR DE PROVEDOR${N}"
echo
echo "  Isto troca o servidor de onde vêm os canais, filmes e séries."
echo "  ${B}O seu link do player não muda.${N} As suas pastas e nomes são"
echo "  levados para o provedor novo quando você sincronizar no editor."
echo

[ -f wrangler.toml ] || parar "Este arquivo é para quem já instalou. Use o instalar.command primeiro."

echo "  Cole o link que o provedor novo te deu. Serve o link com"
echo "  username= e password=, ou o link de uma lista .m3u."
echo

publicar() {
  echo "   Publicando…"
  SAIDA=$(npx wrangler deploy 2>&1)
  URL=$(echo "$SAIDA" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
  if [ -z "$URL" ]; then
    echo "$SAIDA" | tail -20 | sed 's/^/    /'
    parar "Não consegui publicar. Mande a mensagem acima para o Claude."
  fi
  ok "Publicado"
}

LINK=""
TIPO=""
while [ -z "$LINK" ]; do
  read -r -p "  Link: " LINK
  LINK=$(printf '%s' "$LINK" | tr -d '[:space:]')
  DADOS=$(node -e '
    try {
      const u = new URL(process.argv[1]);
      if (!/^https?:$/.test(u.protocol)) throw 0;
      const user = u.searchParams.get("username");
      const pass = u.searchParams.get("password");
      if (user && pass) console.log(["xtream", u.host, user, pass].join("\n"));
      else console.log(["m3u", u.host].join("\n"));
    } catch (e) { process.exit(1); }
  ' "$LINK" 2>/dev/null) || { aviso "Não reconheci esse link. Ele precisa começar com http:// ou https://"; LINK=""; continue; }
  TIPO=$(echo "$DADOS" | sed -n 1p)
done

# ------------------------------------------------------------ lista M3U
if [ "$TIPO" = "m3u" ]; then
  ok "Lista M3U em $(echo "$DADOS" | sed -n 2p)"
  echo "   Testando a lista…"
  CODIGO=$(curl -s -L --max-time 60 -A "VLC/3.0.20" -o /tmp/iptv-lista-teste.m3u -w "%{http_code}" "$LINK")
  if [ "$CODIGO" = "200" ] && head -c 2000 /tmp/iptv-lista-teste.m3u | grep -q "#EXT"; then
    ok "Lista respondeu ($(grep -c '^#EXTINF' /tmp/iptv-lista-teste.m3u) itens)"
  else
    aviso "A lista não abriu daqui (resposta $CODIGO)."
    echo "     Se ela abre no seu navegador, dá para seguir: no editor use"
    echo "     o botão ${B}Abrir arquivo .m3u${N} com o arquivo baixado."
    read -r -p "   Trocar assim mesmo? (s/N) " RESP
    [ "$RESP" = "s" ] || [ "$RESP" = "S" ] || parar "Nada foi alterado."
  fi
  rm -f /tmp/iptv-lista-teste.m3u

  echo "   Guardando o link na Cloudflare…"
  printf '%s' "$LINK" | npx wrangler secret put SOURCE_M3U >/dev/null 2>&1 || parar "Não consegui guardar o link."
  ok "Fonte trocada para a lista M3U"
  publicar

  cat <<FIM

  ─────────────────────────────────────────────

  Falta só um passo, no editor:

    1. Clique em ${B}Sincronizar${N} (ou em ${B}Abrir arquivo .m3u${N}, se a
       lista só abre no seu navegador). O editor leva as suas pastas
       e nomes pelo nome de cada item e mostra o que ficou sem par.
    2. Confira a pasta ${B}Sem pasta${N} e clique em ${B}Publicar${N}.

     ${C}$URL/admin${N}

FIM
  read -r -p "  Aperte Enter para abrir o editor."
  open "$URL/admin" 2>/dev/null
  exit 0
fi

# ------------------------------------------------------- provedor Xtream
DADOS=$(echo "$DADOS" | sed 1d)

XHOST=$(echo "$DADOS" | sed -n 1p)
XUSER=$(echo "$DADOS" | sed -n 2p)
XPASS=$(echo "$DADOS" | sed -n 3p)
ok "Servidor novo: $XHOST"

# Confere se o provedor aceita o usuario e a senha (auth = 1), em https e depois http.
echo "   Testando o provedor novo…"
autentica() {
  curl -s --max-time 25 -A "VLC/3.0.20" -G "$1://$XHOST/player_api.php" \
    --data-urlencode "username=$XUSER" --data-urlencode "password=$XPASS" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).user_info.auth==1?0:1)}catch{process.exit(1)}})'
}
ESQUEMA=""
autentica https && ESQUEMA="https"
[ -z "$ESQUEMA" ] && autentica http && ESQUEMA="http"
if [ -z "$ESQUEMA" ]; then
  aviso "O provedor não confirmou esse usuário e senha agora."
  read -r -p "   Quer trocar assim mesmo? (s/N) " RESP
  [ "$RESP" = "s" ] || [ "$RESP" = "S" ] || parar "Nada foi alterado."
  ESQUEMA="http"
else
  ok "Usuário e senha aceitos ($ESQUEMA)"
fi

node -e '
  const fs=require("fs"), f="wrangler.toml";
  fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace(/^XTREAM_SCHEME = ".*"$/m, `XTREAM_SCHEME = "${process.argv[1]}"`));
' "$ESQUEMA"

echo "   Guardando os dados novos na Cloudflare…"
guardar() {
  printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null 2>&1 || parar "Não consegui guardar $1."
}
guardar XTREAM_HOST "$XHOST"
guardar XTREAM_USER "$XUSER"
guardar XTREAM_PASS "$XPASS"
# sai do modo lista M3U, se ele estava ligado
printf 'y\n' | npx wrangler secret delete SOURCE_M3U >/dev/null 2>&1 || true
ok "Provedor trocado"

publicar

cat <<FIM

  ─────────────────────────────────────────────

  Falta só um passo, no editor:

    1. Clique em ${B}Sincronizar${N}. O editor percebe que o provedor
       mudou e leva as suas pastas e nomes pelo nome de cada item.
       No fim ele mostra quantos acharam par e quais ficaram sem.
    2. Itens que só o provedor novo tem ficam em ${B}Sem pasta${N}.
    3. Clique em ${B}Publicar${N}.

     ${C}$URL/admin${N}

FIM
read -r -p "  Aperte Enter para abrir o editor."
open "$URL/admin" 2>/dev/null
