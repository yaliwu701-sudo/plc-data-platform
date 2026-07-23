@echo off
cd /d "C:\Users\Administrator\WorkBuddy\2026-07-23-08-20-22\plc-data-platform"

REM 确保 logs 目录存在
if not exist logs mkdir logs

REM 设置端口（3000 已被其他项目占用，默认用 3001）
set PORT=3001

REM 运行模式：mock | real（接真机时改成 real）
set PLC_MODE=mock

REM 启动服务，日志写入 logs 目录
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" server/index.js >> logs\startup.log 2>&1
