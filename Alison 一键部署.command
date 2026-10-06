#!/usr/bin/env bash
# Alison for macOS —— 一键部署 + 启动
#   首次双击：装依赖 → 建工作区 → 启动 → 自动打开浏览器
#   之后双击：直接启动
set -u
cd "$(dirname "$0")"
BASE="$(pwd)"
say() { printf '%s\n' "$*"; }

# 0) 去掉下载隔离标记（对自己不需要管理员）
xattr -dr com.apple.quarantine "$BASE" 2>/dev/null || true

# 1) 补执行权限（从 zip 解压时偶有丢失）
chmod +x "$BASE/runtime/node" 2>/dev/null || true
chmod +x "$BASE"/*.command 2>/dev/null || true
chmod +x "$BASE"/Alison.app/Contents/MacOS/* 2>/dev/null || true

# 2) 选 Node：优先系统 node（想用 livingmemory 等插件需要 ≥22）
NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x "$BASE/runtime/node" ] && NODE="$BASE/runtime/node"
if [ -z "$NODE" ]; then
  say "❌ 没有找到 Node.js。请先安装：brew install node"
  read -n 1 -s -r -p "按任意键退出…"; exit 1
fi
say "使用 Node：$("$NODE" -v)"

# 3) 首次才算"部署"：装依赖 + 初始化工作区
if [ ! -d "$BASE/workspace" ] || [ ! -f "$BASE/node_modules/koishi/bin.js" ]; then
  say "首次部署：安装依赖（几分钟，需要联网）…"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack yarn install || npm install --legacy-peer-deps
  elif command -v yarn >/dev/null 2>&1; then
    yarn install
  else
    npm install --legacy-peer-deps
  fi
  mkdir -p "$BASE/workspace/data"
  if [ ! -f "$BASE/workspace/alison.yml" ]; then
    cp "$BASE/alison.yml.example" "$BASE/workspace/alison.yml"
    say "已生成 workspace/alison.yml（也可以直接在网页里按引导填 API Key）"
  fi
  [ -d "$BASE/data/chathub" ] && cp -R "$BASE/data/chathub" "$BASE/workspace/data/" 2>/dev/null || true
  [ -f "$BASE/alison.test.yml.example" ] && cp "$BASE/alison.test.yml.example" "$BASE/workspace/alison.test.yml" 2>/dev/null || true
fi

# 4) 启动 + 自动开界面
PORT="$(grep -E '^[[:space:]]+port:' "$BASE/workspace/alison.yml" 2>/dev/null | head -1 | tr -dc '0-9')"
PORT="${PORT:-5140}"
URL="http://127.0.0.1:${PORT}/alison"
say "============================================"
say " Alison 启动中"
say " 工作区：$BASE/workspace"
say " 界面：  $URL"
say "============================================"
( for i in $(seq 1 90); do
    sleep 2
    if curl -s -o /dev/null "$URL/api/bootstrap"; then open "$URL" >/dev/null 2>&1 || true; break; fi
  done ) &

cd "$BASE/workspace"
"$NODE" "$BASE/node_modules/koishi/bin.js" start alison.yml
say ""
say "Alison 已退出。按任意键关闭窗口…"
read -n 1 -s -r
