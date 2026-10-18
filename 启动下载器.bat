@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.12 或更新的 LTS 版本：https://nodejs.org/
  pause
  exit /b 1
)
set "NEED_INSTALL="
if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
if not exist "node_modules\ffmpeg-static\ffmpeg.exe" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\vite.cmd" set "NEED_INSTALL=1"
if defined NEED_INSTALL (
  echo 正在安装 TypeScript、React 和桌面运行组件，请保持网络连接...
  call npm install
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
