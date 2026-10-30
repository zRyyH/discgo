@echo off
rem Runs the API in dev, like `make api`, without make or Git Bash.
rem cmd: `api` from the repository root; PowerShell: `.\api`.
setlocal
cd /d "%~dp0"

if not exist deploy\.env.dev copy deploy\.env.example deploy\.env.dev >nul
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("deploy\.env.dev") do set "%%a=%%b"

where go >nul 2>nul || set "PATH=%LOCALAPPDATA%\Programs\go\bin;%PATH%"

cd api
go run ./cmd/api
