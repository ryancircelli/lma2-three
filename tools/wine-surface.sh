#!/usr/bin/env bash
# Fast, cropped reference sequences of the ORIGINAL, for the animated water
# surface (and anything else small and fast). Sibling of tools/wine-ref.sh -
# same private prefix, same private Xvfb display (never :0), same BOM-free sed
# edit of the prefix's OWN settings.xml copy. Run `tools/wine-ref.sh setup` first.
#
#   tools/wine-surface.sh OUTDIR [scene] [caustics 0|1] [frames] [crop WxH+X+Y] [delay-s]
#
# Sound off; fish=0 unless LMA2_FISH=1 (the install's tank). Scene toggles
# from <sceneparams> via env (0/1):
#   LMA2_WATER (default 1)   the water surface - 0 gives a surface-free baseline
#   LMA2_BUBLES (default 0)  bubbles       LMA2_PLANTS (default 0) plantsmoving
#   LMA2_BG (default 1)      background    LMA2_FG (default 1)     foreground
# Frames are grabbed in-process by tools/surfacegrab.py (Pillow's X11 grabber), back
# to back unless LMA2_GAP=<s>; times.txt has each grab's timestamp. Frames
# are named f0000.png...

set -euo pipefail

PREFIX="${LMA2_WINEPREFIX:-$HOME/.wine-lma2}"
SCR_NAME="Living Marine Aquarium 2 Full.scr"
APP_DIR="$PREFIX/drive_c/Program Files/Freeze.com/Living Marine Aquarium 2 Full"
export WINEPREFIX="$PREFIX" WINEARCH=win32 WINEDEBUG=-all
unset WAYLAND_DISPLAY

outdir="${1:?usage: $0 OUTDIR [scene] [caustics] [frames] [crop] [delay]}"
scene="${2:-1}" caustic="${3:-0}" frames="${4:-60}" crop="${5:-1024x140+0+0}" delay="${6:-13}"
[ -f "$APP_DIR/settings.base.xml" ] || { echo "run: tools/wine-ref.sh setup" >&2; exit 1; }

sed -e "s/<index value=\"[0-9]*\"/<index value=\"$scene\"/" \
    -e 's/<videomode value="[0-9]*"/<videomode value="0"/' \
    -e "s/<caustic value=\"[0-9]*\"/<caustic value=\"$caustic\"/" \
    -e "s/<causticonfish value=\"[0-9]*\"/<causticonfish value=\"$caustic\"/" \
    -e 's/<sound value="[0-9]*"/<sound value="0"/' \
    -e 's/<volume value="[0-9]*"/<volume value="0"/' \
    -e "$([ "${LMA2_FISH:-0}" = 1 ] && echo 's/x/x/' || echo 's/<fish value="[0-9]*"/<fish value="0"/g')" \
    -e "s/<water value=\"[0-9]*\"/<water value=\"${LMA2_WATER:-1}\"/" \
    -e "s/<bubles value=\"[0-9]*\"/<bubles value=\"${LMA2_BUBLES:-0}\"/" \
    -e "s/<plantsmoving value=\"[0-9]*\"/<plantsmoving value=\"${LMA2_PLANTS:-0}\"/" \
    -e "s/<background value=\"[0-9]*\"/<background value=\"${LMA2_BG:-1}\"/" \
    -e "s/<foreground value=\"[0-9]*\"/<foreground value=\"${LMA2_FG:-1}\"/" \
    "$APP_DIR/settings.base.xml" > "$APP_DIR/settings.xml"

outdir="$(realpath -m "$outdir")"
here="$(dirname "$(realpath "$0")")"
gap="${LMA2_GAP:-0}" # min seconds between grabs (0 = back to back)
[[ "$crop" =~ ^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$ ]] || { echo "bad crop: $crop" >&2; exit 1; }
cw=${BASH_REMATCH[1]} ch=${BASH_REMATCH[2]} cx=${BASH_REMATCH[3]} cy=${BASH_REMATCH[4]}
mkdir -p "$outdir"
rm -f "$outdir"/f*.png "$outdir/times.txt"
xvfb-run -a -s "-screen 0 1024x768x24 +extension GLX -nolisten tcp" bash -c '
  wine "C:\\windows\\'"$SCR_NAME"'" /s & pid=$!
  sleep '"$delay"'
  kill -0 $pid 2>/dev/null || { echo "screensaver exited early" >&2; exit 1; }
  python3 "'"$here"'/surfacegrab.py" "'"$outdir"'" '"$frames $cx $cy $cw $ch $gap"'
  wineserver -k
'
echo "scene=$scene caustics=$caustic water=${LMA2_WATER:-1} crop=$crop: $frames frames -> $outdir"
