@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Alison 独立项目 - 安装依赖
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
node -v
echo.
corepack yarn install
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败，请检查网络或 Node 版本。
  pause
  exit /b 1
)
echo.
echo 安装完成。现在可以编辑 koishi.yml 填入 API Key，然后运行 start.cmd
pause
