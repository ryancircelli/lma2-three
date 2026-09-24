#!/usr/bin/env bash
# Fast frame bursts from the ORIGINAL screensaver (sibling of wine-ref.sh, which
# must have been `setup` first in the same LMA2_WINEPREFIX).
#
#   tools/wine-burst.sh OUTDIR SCENE CAUSTICS FISH BUBLES FRAMES INTERVAL X Y W H [DELAY] [WATER]
#
# Captures a W x H crop at (X,Y) FRAMES times, INTERVAL seconds apart, through
# tools/xgrab.py (one persistent Xlib connection: a few ms per crop instead of
# ImageMagick import's ~0.5 s). BUBLES / WATER set the <bubles> / <water> scene
# params (the app's own spelling) in the private settings copy.
#
# Same safety rules as wine-ref.sh: private Xvfb display only (xvfb-run -a),
# own WINEPREFIX, and only the private settings.xml copy is written (by sed,
# from the BOM-free settings.base.xml).

set -euo pipefail

PREFIX="${LMA2_WINEPREFIX:?set LMA2_WINEPREFIX to your own prefix}"
SCR_NAME="Living Marine Aquarium 2 Full.scr"
APP_DIR="$PREFIX/drive_c/Program Files/Freeze.com/Living Marine Aquarium 2 Full"
HERE="$(cd "$(dirname "$0")" && pwd)"

export WINEPREFIX="$PREFIX" WINEARCH=win32 WINEDEBUG=-all
unset WAYLAND_DISPLAY

[ $# -ge 11 ] || { sed -n '2,15p' "$0"; exit 1; }
outdir="$1" scene="$2" caustic="$3" fish="$4" bubles="$5" frames="$6" interval="$7"
cx="$8" cy="$9" cw="${10}" ch="${11}" delay="${12:-8}" water="${13:-1}"
[ -f "$APP_DIR/settings.base.xml" ] || { echo "run: tools/wine-ref.sh setup" >&2; exit 1; }

fishexpr='s/x/x/'
[ "$fish" = 0 ] && fishexpr='s/<fish value="[0-9]*"/<fish value="0"/g'
sed -e "s/<index value=\"[0-9]*\"/<index value=\"$scene\"/" \
    -e 's/<videomode value="[0-9]*"/<videomode value="0"/' \
    -e "s/<caustic value=\"[0-9]*\"/<caustic value=\"$caustic\"/" \
    -e "s/<causticonfish value=\"[0-9]*\"/<causticonfish value=\"$caustic\"/" \
    -e "s/<bubles value=\"[0-9]*\"/<bubles value=\"$bubles\"/" \
    -e "s/<water value=\"[0-9]*\"/<water value=\"$water\"/" \
    -e 's/<sound value="[0-9]*"/<sound value="0"/' \
    -e 's/<volume value="[0-9]*"/<volume value="0"/' \
    -e "$fishexpr" \
    "$APP_DIR/settings.base.xml" > "$APP_DIR/settings.xml"

outdir="$(realpath -m "$outdir")"
rm -rf "$outdir"
mkdir -p "$outdir"
xvfb-run -a -s "-screen 0 1024x768x24 +extension GLX -nolisten tcp" bash -c '
  wine "C:\\windows\\'"$SCR_NAME"'" /s & pid=$!
  sleep '"$delay"'
  if ! kill -0 $pid 2>/dev/null; then echo "screensaver exited early" >&2; exit 1; fi
  python3 "'"$HERE"'/xgrab.py" "'"$outdir"'" '"$frames"' '"$interval"' '"$cx"' '"$cy"' '"$cw"' '"$ch"'
  wineserver -k
'
echo "scene=$scene caustics=$caustic fish=$fish bubles=$bubles water=$water -> $outdir"
