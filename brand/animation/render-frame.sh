#!/usr/bin/env bash
# Usage: render-frame.sh <frame-index> [fps]
# Renders one deterministic frame of logo-animation.html to frames/fNNNN.png (needs Microsoft Edge).
i=$1; fps=${2:-24}
dir="C:/Users/Nitro/Desktop/Work/er-atlas/brand/animation"
t=$(awk -v i="$i" -v f="$fps" 'BEGIN{printf "%.4f", i/f}')
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files --virtual-time-budget=1500 --window-size=1920,1080 \
  --screenshot="$dir/frames/f$(printf %04d "$i").png" "file:///$dir/logo-animation.html?t=$t" >/dev/null 2>&1
