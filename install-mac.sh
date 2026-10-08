#!/usr/bin/env bash
# Alison for macOS —— 首次安装脚本
set -e
cd "$(dirname "$0")"

echo "============================================"
echo " Alison for macOS —— 安装依赖"
echo "============================================"

# zip 不保留 Unix 权限位，先补执行权限
chmod +x ./runtime/node 2>/dev/null || true

if ! command -v node >/dev/null 2>&1; then
  if [ -x "./runtime/node" ]; then
    export PATH="$PWD/runtime:$PATH"
    echo "使用包内自带的 Node: $(./runtime/node -v)"
  else
    echo "❌ 没有找到 Node.js，请先安装：brew install node"
    exit 1
  fi
else
  echo "使用系统 Node: $(node -v)"
fi

echo
echo "→ 安装依赖（首次需要几分钟，会从 npm 镜像下载）…"
if command -v yarn >/dev/null 2>&1; then
  yarn install
elif command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack yarn install
else
  echo "  （没有 yarn/corepack，退回 npm）"
  npm install --legacy-peer-deps
fi

echo
echo "→ 初始化工作区…"
mkdir -p workspace/data
if [ ! -f workspace/alison.yml ]; then
  cp alison.yml.example workspace/alison.yml
  echo "  已生成 workspace/alison.yml"
else
  cp alison.yml.example workspace/alison.yml.example.new 2>/dev/null || true
  echo "  workspace/alison.yml 已存在，保留你的配置"
fi
[ -d data/chathub ] && cp -R data/chathub workspace/data/ 2>/dev/null || true
cp alison.test.yml.example workspace/alison.test.yml 2>/dev/null || true

echo
echo "→ 设置执行权限…"
chmod +x "启动 Alison.command" "停止 Alison.command" "install-mac.sh" 2>/dev/null || true
[ -f "./runtime/node" ] && chmod +x ./runtime/node 2>/dev/null || true

echo
echo "✅ 安装完成。下一步："
echo "   1. 也可以直接双击启动，在网页里按引导填 API Key（或改 workspace/alison.yml）"
echo "   2. 双击「启动 Alison.command」"
echo "   3. 浏览器会自动打开 http://127.0.0.1:5140/ice"
echo
