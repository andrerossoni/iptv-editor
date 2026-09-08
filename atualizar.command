#!/bin/bash
# Aplica as melhorias mais recentes. Duplo clique neste arquivo.

cd "$(dirname "$0")" || exit 1
B=$'\033[1m'; V=$'\033[32m'; A=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'

clear
echo
echo "  ${B}📺 IPTV EDITOR — ATUALIZAR${N}"
echo
echo "  Isto traz as melhorias novas para o seu link."
echo "  ${B}As suas edições e a sua lista não são apagadas.${N}"
echo
read -r -p "  Aperte Enter para começar."

if [ ! -f wrangler.toml ]; then
  printf "\n${R}   ✗ Este atualizador é para quem já instalou.${N}\n"
  echo   "     Use o instalar.command primeiro."
  echo; read -r -p "   Aperte Enter para fechar."; exit 1
fi

echo
echo "  Baixando as novidades…"
if [ -d .git ]; then
  git stash push -q --include-untracked -- wrangler.toml 2>/dev/null
  git pull --rebase -q origin main 2>&1 | sed 's/^/    /'
  git stash pop -q 2>/dev/null
  printf "${V}   ✓ Novidades baixadas${N}\n"
else
  printf "${A}   ! Sem histórico do Git aqui; sigo com os arquivos atuais.${N}\n"
fi

echo "  Instalando componentes…"
npm install --no-audit --no-fund --silent 2>/dev/null
printf "${V}   ✓ Pronto${N}\n"

echo "  Publicando…"
SAIDA=$(npx wrangler deploy 2>&1)
URL=$(echo "$SAIDA" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)

if [ -z "$URL" ]; then
  echo "$SAIDA" | tail -20 | sed 's/^/    /'
  printf "\n${R}   ✗ Não consegui publicar. Mande a mensagem acima para o Claude.${N}\n"
  echo; read -r -p "   Aperte Enter para fechar."; exit 1
fi

printf "${V}   ✓ Atualizado!${N}\n"
cat <<FIM

  ─────────────────────────────────────────────

  Tudo pronto. O seu link continua o mesmo:

     ${C}$URL/admin${N}

  ${B}Importante:${N} entre no editor e clique em ${B}Publicar${N}
  de novo, para o player receber as mudanças.

FIM
read -r -p "  Aperte Enter para abrir o editor."
open "$URL/admin" 2>/dev/null
