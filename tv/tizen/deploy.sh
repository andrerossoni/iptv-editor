#!/bin/sh
# Monta, assina e instala o app na TV.  Uso: sh tizen/deploy.sh [IP da TV]
# Precisa do Tizen Studio em ~/tizen-studio e do perfil de certificado "IPTVCinema".
set -e
TV=${1:-192.168.1.12}
TIZEN=~/tizen-studio/tools/ide/bin/tizen
SDB=~/tizen-studio/tools/sdb
cd "$(dirname "$0")"
node build.js
(cd build && $TIZEN package -t wgt -s IPTVCinema >/dev/null)
mkdir -p out
mv -f "build/IPTV Cinema.wgt" out/IPTVCinema.wgt
$SDB connect "$TV" >/dev/null
$TIZEN install -n IPTVCinema.wgt -s "$TV:26101" -- out | grep -i "success\|error\|fail"
$TIZEN run -p IPTVcinema.App -s "$TV:26101" | tail -1
