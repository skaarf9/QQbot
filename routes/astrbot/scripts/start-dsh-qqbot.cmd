@echo off
chcp 65001 >nul
echo [i] DSH qqbot profile: WebUI http://127.0.0.1:8090, ingress http://127.0.0.1:3188
REM QQ 这条线要能跑 selfext（装插件/升级/重启），必须给完整文件权限；
REM 审批策略为 never：需要审批的操作会被直接拒绝，不会来问，适合无人值守的 QQ 会话。
set "DSH_PERMISSION_MODE=danger-full-access"
dsh --profile qqbot --port 8090 --no-open
