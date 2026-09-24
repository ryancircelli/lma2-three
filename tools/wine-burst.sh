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
# LMA2_PARAMS="foreground=0 background=0 plantsmoving=0" sets any other
# <name value="N"> settings the same way.
#
# <volume> is left as installed (1): it drives the LIGHT RAYS, not the sound
# (docs/original-logic.md 5.1). Pass volume=0 to capture without rays.
#
# LMA2_STALL="0.4 1.5" freezes the app (SIGSTOP) for 0.4 s every 1.5 s during
# the burst - a test of whether its animation is time-based (things jump after
# a stall) or per-frame (they carry on as if nothing happened). Only processes
# whose environment carries THIS WINEPREFIX are signalled.
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

[ $# -ge 11 ] || { sed -n '2,22p' "$0"; exit 1; }
outdir="$1" scene="$2" caustic="$3" fish="$4" bubles="$5" frames="$6" interval="$7"
cx="$8" cy="$9" cw="${10}" ch="${11}" delay="${12:-8}" water="${13:-1}"
[ -f "$APP_DIR/settings.base.xml" ] || { echo "run: tools/wine-ref.sh setup" >&2; exit 1; }

extra=()
for kv in ${LMA2_PARAMS:-}; do extra+=(-e "s/<${kv%%=*} value=\"[0-9]*\"/<${kv%%=*} value=\"${kv#*=}\"/"); done
fishexpr='s/x/x/'
[ "$fish" = 0 ] && fishexpr='s/<fish value="[0-9]*"/<fish value="0"/g'
sed -e "s/<index value=\"[0-9]*\"/<index value=\"$scene\"/" \
    -e 's/<videomode value="[0-9]*"/<videomode value="0"/' \
    -e "s/<caustic value=\"[0-9]*\"/<caustic value=\"$caustic\"/" \
    -e "s/<causticonfish value=\"[0-9]*\"/<causticonfish value=\"$caustic\"/" \
    -e "s/<bubles value=\"[0-9]*\"/<bubles value=\"$bubles\"/" \
    -e "s/<water value=\"[0-9]*\"/<water value=\"$water\"/" \
    -e 's/<sound value="[0-9]*"/<sound value="0"/' \
    -e "$fishexpr" "${extra[@]}" \
    "$APP_DIR/settings.base.xml" > "$APP_DIR/settings.xml"

outdir="$(realpath -m "$outdir")"
rm -rf "$outdir"
mkdir -p "$outdir"

# Runs inside the private X server. Arguments come in as positional
# parameters, so nothing needs re-quoting.
inner() {
  local scr="$1" delay="$2" outdir="$3" frames="$4" interval="$5" cx="$6" cy="$7" cw="$8" ch="$9" stall="${10}" prefix="${11}" here="${12}"
  wine "C:\\windows\\$scr" /s &
  local pid=$! stallpid=""
  sleep "$delay"
  if ! kill -0 "$pid" 2>/dev/null; then echo "screensaver exited early" >&2; return 1; fi
  if [ -n "$stall" ]; then
    set -- $stall
    local hold="$1" every="$2"
    (
      while :; do
        sleep "$every"
        for p in $(pgrep -f "Full.scr"); do
          # Only the app itself (comm = its truncated exe name) - never this
          # script's shells, whose command lines name the .scr too.
          case "$(cat "/proc/$p/comm" 2>/dev/null)" in Living* | *.scr*) ;; *) continue ;; esac
          tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "WINEPREFIX=$prefix" || continue
          kill -STOP "$p"; date +%s.%N >> "$outdir/stalls.txt"; sleep "$hold"; kill -CONT "$p"
        done
      done
    ) & stallpid=$!
  fi
  python3 "$here/xgrab.py" "$outdir" "$frames" "$interval" "$cx" "$cy" "$cw" "$ch"
  if [ -n "$stallpid" ]; then kill "$stallpid"; fi
  wineserver -k
}
# xvfb-run is a POSIX sh script, which drops exported bash functions: pass the source.
xvfb-run -a -s "-screen 0 1024x768x24 +extension GLX -nolisten tcp" \
  bash -c "$(declare -f inner); inner \"\$@\"" _ "$SCR_NAME" "$delay" "$outdir" "$frames" "$interval" "$cx" "$cy" "$cw" "$ch" "${LMA2_STALL:-}" "$PREFIX" "$HERE"
echo "scene=$scene caustics=$caustic fish=$fish bubles=$bubles water=$water ${LMA2_PARAMS:-} -> $outdir"
