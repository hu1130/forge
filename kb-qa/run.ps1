# kb-qa 一键启动（Windows PowerShell）：创建虚拟环境、安装依赖、启动服务
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".venv")) {
    py -3 -m venv .venv
}
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --port 8000
