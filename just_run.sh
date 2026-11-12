#!/bin/zsh
# 一键启动：读取 .env 生成密钥文件，用支持命令行加载扩展的浏览器打开英文样例页。
# 官方版 Chrome 从 137 起移除 --load-extension，所以这里优先找 Chrome for Testing 或 Chromium。
set -e
cd "$(dirname "$0")"

EXT_DIR="$PWD"
PROFILE_DIR="$PWD/.chrome_profile"
PAGE="file://$EXT_DIR/tests/fixtures/sample_page.html"

if [ ! -f .env ]; then
  echo "缺少 .env，请先复制 .env.example 并填入 GROQ_API_KEY。"
  exit 1
fi

set -a
source .env
set +a

if [ -z "$GROQ_API_KEY" ]; then
  echo ".env 里没有 GROQ_API_KEY。"
  exit 1
fi

KEY_FILE="src/dev_config.json"
cat > "$KEY_FILE" <<EOF
{
  "_note": "由 just_run.sh 依据 .env 生成，已被 .gitignore 忽略，请勿把真实密钥提交到任何仓库。",
  "apiKey": "$GROQ_API_KEY"
}
EOF
echo "已依据 .env 写入 $KEY_FILE"

find_chrome() {
  local candidates=()
  [ -n "$CHROME_BIN" ] && candidates+=("$CHROME_BIN")
  candidates+=("/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
  local cached
  for cached in "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; do
    [ -x "$cached" ] && candidates+=("$cached")
  done
  candidates+=("/Applications/Chromium.app/Contents/MacOS/Chromium")
  for bin in "${candidates[@]}"; do
    if [ -x "$bin" ]; then
      echo "$bin"
      return 0
    fi
  done
  return 1
}

CHROME="$(find_chrome || true)"
if [ -z "$CHROME" ]; then
  echo "没有找到 Chrome for Testing 或 Chromium，官方版 Chrome 无法命令行加载扩展。"
  echo "安装一条命令即可：node_modules/.bin/playwright-core install chromium"
  exit 1
fi

PROXY_ARGS=()
if [ -n "$HTTPS_PROXY" ]; then
  PROXY_ARGS=(--proxy-server="$HTTPS_PROXY" --proxy-bypass-list="127.0.0.1;localhost")
  echo "使用代理 $HTTPS_PROXY"
fi

if pgrep -f "user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
  echo "检测到本项目浏览器已在运行，直接打开页面。"
  "$CHROME" --user-data-dir="$PROFILE_DIR" "$PAGE" >/dev/null 2>&1 &
  exit 0
fi

mkdir -p "$PROFILE_DIR"
echo "使用浏览器 $CHROME"
echo "正在启动并加载扩展"

"$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --disable-extensions-except="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "${PROXY_ARGS[@]}" \
  "$PAGE" >/dev/null 2>&1 &

sleep 3
echo ""
echo "启动完成，用法："
echo "1. 点工具栏的扩展图标，再点 翻译此页。"
echo "2. 页面右下角出现进度胶囊，显示已译段数与队列。"
echo "3. 滚动到哪译到哪，停止滚动约 2.5 秒后补全剩余内容。"
echo "4. 选中英文会浮出翻译按钮，鼠标停在译文上显示原句。"
echo "5. 快捷键 Alt+Shift+T 切换译文与原文。"
