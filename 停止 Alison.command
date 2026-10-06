#!/usr/bin/env bash
# Alison for macOS —— 停止
cd "$(dirname "$0")"
PORT="$(grep -E '^[[:space:]]+port:' workspace/alison.yml 2>/dev/null | head -1 | tr -dc '0-9')"
PORT="${PORT:-5140}"
PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PID" ]; then
  echo "停止监听 $PORT 的进程：$PID"
  kill "$PID" 2>/dev/null || true
else
  echo "没有在监听 $PORT 的进程。"
fi
sleep 1
echo "完成。"
