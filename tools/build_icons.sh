#!/bin/zsh
# 重新生成扩展图标：先用无头 Chrome 把 tools/icon.html 截成 128 像素，再等比缩放出全套尺寸。
set -e
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "未找到 Google Chrome，无法生成图标。"
  exit 1
fi

mkdir -p icons
TMP_PROFILE="$(mktemp -d)"

"$CHROME" \
  --headless \
  --disable-gpu \
  --hide-scrollbars \
  --no-first-run \
  --user-data-dir="$TMP_PROFILE" \
  --force-device-scale-factor=1 \
  --default-background-color=00000000 \
  --window-size=128,128 \
  --screenshot="$PWD/icons/icon128.png" \
  "file://$PWD/tools/icon.html" >/dev/null 2>&1

rm -rf "$TMP_PROFILE"

for size in 48 32 16; do
  sips -z $size $size icons/icon128.png --out "icons/icon${size}.png" >/dev/null
done

ls -l icons
