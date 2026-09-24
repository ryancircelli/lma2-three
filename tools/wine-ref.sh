#!/usr/bin/env bash
# Reference frames from the ORIGINAL screensaver, rendered by Wine on a private
# virtual X display - so nothing ever appears on, or changes, the real desktop.
#
# Why this exists: the screensaver forces the display into its own <videomode>
# (measured 2400x1600 -> 640x480). Capturing it natively flips the host's real
# monitor every time. Under Xvfb that mode change hits an invisible framebuffer.
#
#   tools/wine-ref.sh setup                     # once: private Wine prefix + copy of the install
#   tools/wine-ref.sh capture OUT.png [scene] [caustics 0|1] [fish 0|1] [delay-seconds]
#
# Caveat: Wine renders Direct3D through OpenGL (wined3d) on Mesa's software
# rasteriser. Layout, layering, texturing and framing are trustworthy; exact
# colour and filtering are Wine's, not the 2005 driver's.
#
# Never uses WSLg's DISPLAY=:0 (that one draws on the Windows desktop):
# xvfb-run -a always picks a fresh private display.

set -euo pipefail

PREFIX="${LMA2_WINEPREFIX:-$HOME/.wine-lma2}"
SRC="${LMA2_SOURCE:-/mnt/c/Program Files (x86)/Freeze.com/Living Marine Aquarium 2 Full}"
SCR_NAME="Living Marine Aquarium 2 Full.scr"
SCR_SRC="${LMA2_SCR:-/mnt/c/Windows/$SCR_NAME}"
APP_DIR="$PREFIX/drive_c/Program Files/Freeze.com/Living Marine Aquarium 2 Full"

export WINEPREFIX="$PREFIX" WINEARCH=win32 WINEDEBUG="${LMA2_WINEDEBUG:--all}"
# Optional overrides, for motion measurements:
#   LMA2_SCHOOLING=0|1   the <schooling> setting (default: the install's)
#   LMA2_CROP=WxH+X+Y    capture only this region (faster - fish tracking)
#   LMA2_EXT=ppm         frame format (ppm writes faster than png)
#   LMA2_GRAB=fast      grab with tools/xgrab.py (ms per frame, ppm)
#   LMA2_SECONDS=20     with LMA2_GRAB=fast: poll for this long, keep only new
#                        renders (each timed by its first appearance)
#   LMA2_WINEDEBUG=fps   wined3d prints the app's frame rate to stderr
#   LMA2_TANK="Sea Horse=2,Flame Angel=3"   stock ONLY these species (with fish=1);
#                        a species missing from settings.xml gets a line added
EXTRA_SED=(-e 's/x/x/')
[ -n "${LMA2_SCHOOLING:-}" ] && EXTRA_SED+=(-e "s/<schooling value=\"[0-9]*\"/<schooling value=\"$LMA2_SCHOOLING\"/")
#   LMA2_BARE=1          no water/bubbles/foreground/background: creatures on
#                        flat water, rendered many times faster (see notes)
[ -n "${LMA2_BARE:-}" ] && for _k in water plantsmoving bubles foreground background; do
  EXTRA_SED+=(-e "s/<$_k value=\"[0-9]*\"/<$_k value=\"0\"/")
done
if [ -n "${LMA2_TANK:-}" ]; then
  EXTRA_SED+=(-e 's/<fish value="[1-9][0-9]*"/<fish value="0"/g')
  IFS=',' read -ra _entries <<< "$LMA2_TANK"
  for _e in "${_entries[@]}"; do
    _n="${_e%=*}" _c="${_e##*=}"
    EXTRA_SED+=(-e "/name=\"$_n\"/d" -e "/<\/fishes>/i\\            <fish value=\"$_c\" name=\"$_n\" />")
  done
fi
CROP="${LMA2_CROP:+-crop $LMA2_CROP +repage}"
EXT="${LMA2_EXT:-png}"
unset WAYLAND_DISPLAY  # keep Wine off WSLg entirely

# Run a command on a throwaway private X server (never :0).
on_xvfb() { xvfb-run -a -s "-screen 0 1024x768x24 +extension GLX -nolisten tcp" "$@"; }

cmd_setup() {
  [ -d "$SRC" ] || { echo "install not found: $SRC" >&2; exit 1; }
  [ -f "$SCR_SRC" ] || { echo "screensaver not found: $SCR_SRC" >&2; exit 1; }
  if [ ! -f "$PREFIX/system.reg" ]; then
    echo "creating 32-bit Wine prefix at $PREFIX"
    on_xvfb wineboot --init
    on_xvfb wineserver --wait
  fi
  echo "copying install -> $APP_DIR"
  mkdir -p "$APP_DIR"
  cp -r "$SRC/." "$APP_DIR/"
  cp "$SCR_SRC" "$PREFIX/drive_c/windows/$SCR_NAME"
  # Pristine settings to derive every capture from. Must stay BOM-free: the
  # app's XML parser dies on a BOM.
  cp "$APP_DIR/settings.xml" "$APP_DIR/settings.base.xml"
  if [ "$(head -c3 "$APP_DIR/settings.base.xml" | od -An -tx1 | tr -d ' ')" = "efbbbf" ]; then
    echo "settings.xml has a BOM - the screensaver will not start with it" >&2; exit 1
  fi
  # The .scr finds its data folder through this key (see README).
  local key='HKLM\Software\Triodesign\Living Marine Aquarium 2.0'
  on_xvfb wine reg add "$key" /v InstallPath /t REG_SZ /d 'C:\Program Files\Freeze.com\Living Marine Aquarium 2 Full' /f >/dev/null
  on_xvfb wine reg add "$key" /v ScrFileName /t REG_SZ /d "C:\\windows\\$SCR_NAME" /f >/dev/null
  on_xvfb wine reg add "$key" /v SceneIndex /t REG_DWORD /d 0 /f >/dev/null
  on_xvfb wine reg add 'HKLM\Software\Freeze.com\Living Marine Aquarium 2 Full ScreenSaver' /v Type /t REG_SZ /d Full /f >/dev/null
  on_xvfb wineserver --wait
  echo "ready"
}

cmd_capture() {
  local out="$1" scene="${2:-1}" caustic="${3:-0}" fish="${4:-0}" delay="${5:-9}"
  [ -f "$APP_DIR/settings.base.xml" ] || { echo "run: $0 setup" >&2; exit 1; }
  local fishexpr='s/x/x/'
  [ "$fish" = 0 ] && fishexpr='s/<fish value="[0-9]*"/<fish value="0"/g'
  # videomode is an index into videomodes.xml, which the app rebuilds on every
  # launch from the modes the display offers. Xvfb offers only 1024x768, so the
  # list is always [0]=1024x768x32, [1]=1024x768x16 - and the install's value
  # (2 on the real machine) points past the end, which makes the app abort.
  sed -e "s/<index value=\"[0-9]*\"/<index value=\"$scene\"/" \
      -e 's/<videomode value="[0-9]*"/<videomode value="0"/' \
      -e "s/<caustic value=\"[0-9]*\"/<caustic value=\"$caustic\"/" \
      -e "s/<causticonfish value=\"[0-9]*\"/<causticonfish value=\"$caustic\"/" \
      -e 's/<sound value="[0-9]*"/<sound value="0"/' \
      -e 's/<volume value="[0-9]*"/<volume value="0"/' \
      -e "$fishexpr" "${EXTRA_SED[@]}" \
      "$APP_DIR/settings.base.xml" > "$APP_DIR/settings.xml"
  out="$(realpath -m "$out")"
  mkdir -p "$(dirname "$out")"
  on_xvfb bash -c '
    wine "C:\\windows\\'"$SCR_NAME"'" /s & pid=$!
    sleep '"$delay"'
    if ! kill -0 $pid 2>/dev/null; then echo "screensaver exited early" >&2; exit 1; fi
    import -window root "'"$out"'"
    wineserver -k
  '
  echo "scene=$scene caustics=$caustic fish=$fish -> $out"
}

# A timed frame sequence: how the original ANIMATES (plant sway, anemone
# frames, surface ripple, bubbles, and fish motion) - things a still cannot show.
cmd_sequence() {
  local outdir="$1" scene="${2:-1}" caustic="${3:-0}" fish="${4:-0}" frames="${5:-40}" interval="${6:-0.25}" delay="${7:-8}"
  [ -f "$APP_DIR/settings.base.xml" ] || { echo "run: $0 setup" >&2; exit 1; }
  local fishexpr='s/x/x/'
  [ "$fish" = 0 ] && fishexpr='s/<fish value="[0-9]*"/<fish value="0"/g'
  sed -e "s/<index value=\"[0-9]*\"/<index value=\"$scene\"/" \
      -e 's/<videomode value="[0-9]*"/<videomode value="0"/' \
      -e "s/<caustic value=\"[0-9]*\"/<caustic value=\"$caustic\"/" \
      -e "s/<causticonfish value=\"[0-9]*\"/<causticonfish value=\"$caustic\"/" \
      -e 's/<sound value="[0-9]*"/<sound value="0"/' \
      -e 's/<volume value="[0-9]*"/<volume value="0"/' \
      -e "$fishexpr" "${EXTRA_SED[@]}" \
      "$APP_DIR/settings.base.xml" > "$APP_DIR/settings.xml"
  outdir="$(realpath -m "$outdir")"
  mkdir -p "$outdir"
  rm -f "$outdir"/f*.png "$outdir"/f*.ppm "$outdir/times.txt"
  if [ "${LMA2_GRAB:-}" = fast ]; then
    # Xlib grabs (tools/xgrab.py): milliseconds per frame instead of ~0.7 s.
    local grab; grab="$(dirname "$(realpath "$0")")/xgrab.py"
    on_xvfb bash -c '
      wine "C:\\windows\\'"$SCR_NAME"'" /s & pid=$!
      sleep '"$delay"'
      python3 "'"$grab"'" "'"$outdir"'" '"$frames"' '"$interval"' "'"${LMA2_CROP:-}"'" "$pid" "'"${LMA2_SECONDS:-}"'"
      wineserver -k
    '
    echo "scene=$scene caustics=$caustic fish=$fish schooling=${LMA2_SCHOOLING:-install}: $frames fast frames -> $outdir"
    return
  fi
  on_xvfb bash -c '
    wine "C:\\windows\\'"$SCR_NAME"'" /s & pid=$!
    sleep '"$delay"'
    for i in $(seq -w 0 $(('"$frames"' - 1))); do
      kill -0 $pid 2>/dev/null || { echo "screensaver exited early" >&2; exit 1; }
      date +%s.%N >> "'"$outdir"'/times.txt"
      import -window root '"$CROP"' "'"$outdir"'/f$i.'"$EXT"'"
      sleep '"$interval"'
    done
    wineserver -k
  '
  echo "scene=$scene caustics=$caustic fish=$fish schooling=${LMA2_SCHOOLING:-install}: $frames frames -> $outdir (capture times in times.txt)"
}

case "${1:-}" in
  setup) cmd_setup ;;
  capture) shift; cmd_capture "$@" ;;
  sequence) shift; cmd_sequence "$@" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
