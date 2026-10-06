@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Alison 独立项目 - 启动
echo ============================================
if not exist "node_modules" (
  echo [提示] 还没安装依赖，先运行 install.cmd
  pause
  exit /b 1
)
corepack yarn start
pause
