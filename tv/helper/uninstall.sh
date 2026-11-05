#!/bin/sh
# Desliga o ajudante de miniaturas e apaga as fotos guardadas.
launchctl bootout "gui/$(id -u)/com.iptvcinema.thumbs" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.iptvcinema.thumbs.plist"
rm -rf "$HOME/Library/Application Support/IPTV Cinema/helper" "$HOME/Library/Application Support/IPTV Cinema/thumbs"
echo "Ajudante de miniaturas desligado."
