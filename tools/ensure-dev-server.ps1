# Idempotent local static server for Active Theater (port 8080).
# Usage:
#   powershell -File tools/ensure-dev-server.ps1
#   powershell -File tools/ensure-dev-server.ps1 -Open
#   powershell -File tools/ensure-dev-server.ps1 -Restart

param(
    [int]$Port = 8080,
    [switch]$Open,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Test-PortListening([int]$p) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return [bool]$conns
}

function Wait-HttpOk([int]$p, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}

function Stop-PortListeners([int]$p) {
    $pids = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        if ($procId -and $procId -ne 0) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    $deadline = (Get-Date).AddSeconds(5)
    while ((Test-PortListening $p) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
}

if (-not (Test-Path (Join-Path $Root 'node_modules\serve'))) {
    Write-Host 'Installing deps (serve missing)...'
    npm install
}

if ($Restart -and (Test-PortListening $Port)) {
    Write-Host "Restarting listener on $Port..."
    Stop-PortListeners $Port
}

if (Test-PortListening $Port) {
    Write-Host "Already listening on $Port — OK"
} else {
    Write-Host "Starting serve on $Port..."
    $logOut = Join-Path $env:TEMP "airarena-serve-$Port.out.log"
    $logErr = Join-Path $env:TEMP "airarena-serve-$Port.err.log"
    Start-Process -FilePath 'npm.cmd' -ArgumentList @('start') -WorkingDirectory $Root `
        -WindowStyle Minimized -RedirectStandardOutput $logOut -RedirectStandardError $logErr
    if (-not (Wait-HttpOk $Port)) {
        Write-Host "FAILED: server did not respond on http://127.0.0.1:$Port/"
        if (Test-Path $logOut) { Get-Content $logOut -Tail 20 }
        if (Test-Path $logErr) { Get-Content $logErr -Tail 20 }
        exit 1
    }
    Write-Host "Started — http://127.0.0.1:$Port/"
}

if ($Open) {
    Start-Process "http://127.0.0.1:$Port/"
}

exit 0
