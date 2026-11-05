#!/bin/sh
# Liga o ajudante de miniaturas da TV: roda sozinho sempre que o Mac estiver ligado.
# Desligar: sh tv/helper/uninstall.sh
set -e
DIR="$HOME/Library/Application Support/IPTV Cinema/helper"
PLIST="$HOME/Library/LaunchAgents/com.iptvcinema.thumbs.plist"
NODE=$(command -v node)
mkdir -p "$DIR"
# Copia para fora de Documentos: o macOS bloqueia servicos lendo essa pasta.
cp "$(dirname "$0")/thumbs.mjs" "$DIR/thumbs.mjs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.iptvcinema.thumbs</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/thumbs.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/iptv-cinema-thumbs.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/iptv-cinema-thumbs.log</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/com.iptvcinema.thumbs" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -s -m 3 http://127.0.0.1:8790/ping >/dev/null && echo "Ajudante de miniaturas ligado." || echo "Ajudante nao respondeu: veja ~/Library/Logs/iptv-cinema-thumbs.log"
