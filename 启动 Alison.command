#!/usr/bin/env bash
# Alison for macOS —— 启动（双击本文件）
cd "$(dirname "$0")"
chmod +x ./runtime/node 2>/dev/null || true

NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x "./runtime/node" ] && NODE="$PWD/runtime/node"
if [ -z "$NODE" ]; then
  echo "❌ 找不到 Node，请先运行 install-mac.sh，或 brew install node"
  read -n 1 -s -r -p "按任意键退出…"; exit 1
fi

if [ ! -d "workspace" ]; then
  echo "❌ 还没有初始化，请先运行 install-mac.sh"
  read -n 1 -s -r -p "按任意键退出…"; exit 1
fi

PORT="$(grep -E '^[[:space:]]+port:' workspace/alison.yml | head -1 | tr -dc '0-9')"
PORT="${PORT:-5140}"
URL="http://127.0.0.1:${PORT}/alison"

echo "============================================"
echo " Alison 启动中"
echo " 工作区: $(pwd)/workspace"
echo " 界面:   ${URL}"
echo "============================================"
echo

( for i in $(seq 1 60); do
    sleep 2
    if curl -s -o /dev/null "${URL}/api/bootstrap"; then open "$URL" 2>/dev/null || true; break; fi
  done ) &

cd workspace
CONFIG=alison.yml
[ -f "$CONFIG" ] || CONFIG=koishi.yml
"$NODE" ../node_modules/koishi/bin.js start "$CONFIG"

echo
echo "Alison 已退出。按任意键关闭窗口…"
read -n 1 -s -r
