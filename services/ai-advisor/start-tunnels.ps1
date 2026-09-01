# Re-establish public tunnels for the Waterfind CRM + AI Advisor sidecar.
#
# Quick tunnels get a NEW random *.trycloudflare.com hostname on every launch,
# so the CRM's wf.ai.base-url and the sidecar's CORS_ORIGINS have to be rewritten
# each time. This script does the whole cycle.
#
#   powershell -ExecutionPolicy Bypass -File services\ai-advisor\start-tunnels.ps1
#
# Prerequisites: Resin already serving :81, PostgreSQL running.
# Leaves the SWN named-tunnel Windows service alone.

$ErrorActionPreference = 'Stop'

$CF      = 'C:\Users\chris\cloudflared.exe'
$REPO    = 'C:\Users\chris\src\repos\waterfind'
$SIDECAR = Join-Path $REPO 'services\ai-advisor'
$PROPS   = Join-Path $env:USERPROFILE '.waterfind-ai-advisor.properties'
$ENVF    = Join-Path $SIDECAR '.env'
$JSP     = Join-Path $REPO 'crm\waterfind.com.au\build-dev\waterfind\jsp\userhome\app\ai-advisor.jsp'
$WORK    = Join-Path $env:TEMP 'wf-tunnels'

New-Item -ItemType Directory -Force -Path $WORK | Out-Null

# An empty config file is load-bearing: without --config, cloudflared auto-loads
# ~/.cloudflared/config.yml, whose SWN ingress rules override --url and send every
# request to its http_status:404 catch-all.
$emptyCfg = Join-Path $WORK 'quick-tunnel.yml'
'# intentionally empty - keeps the SWN ingress rules out of these quick tunnels' |
    Set-Content -Path $emptyCfg -Encoding ASCII

Write-Output 'Stopping any previous quick tunnels (leaving the SWN service running)...'
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '--url' } |
    ForEach-Object {
        Write-Output ("  stopping pid {0}" -f $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

function Start-QuickTunnel {
    param([int]$Port, [string]$LogName, [string[]]$Extra = @())
    $log = Join-Path $WORK $LogName
    Remove-Item $log -ErrorAction SilentlyContinue
    $argList = @('tunnel', '--config', $emptyCfg, '--url', "http://localhost:$Port") + $Extra
    Start-Process -FilePath $CF -ArgumentList $argList `
                  -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
                  -WindowStyle Hidden | Out-Null

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        foreach ($f in @($log, "$log.err")) {
            if (Test-Path $f) {
                $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' `
                                   -AllMatches -ErrorAction SilentlyContinue
                if ($m) { return $m.Matches[0].Value }
            }
        }
        Start-Sleep -Milliseconds 700
    }
    throw "Timed out waiting for a trycloudflare URL on port $Port (see $log)"
}

Write-Output 'Starting CRM tunnel (:81)...'
# Deliberately NO --http-host-header. Overriding the Host to localhost:81 makes Resin
# emit absolute redirects to http://localhost:81/... , which resolve only on this
# machine - the tunnel then appears to work locally and is dead on every other computer.
$crmUrl = Start-QuickTunnel -Port 81 -LogName 'tun-crm.log'
Write-Output "  $crmUrl"

Write-Output 'Starting sidecar tunnel (:3100)...'
$aiUrl = Start-QuickTunnel -Port 3100 -LogName 'tun-ai.log'
Write-Output "  $aiUrl"

Write-Output 'Rewriting config...'
(Get-Content $PROPS) -replace '^wf\.ai\.base-url=.*', "wf.ai.base-url=$aiUrl" |
    Set-Content $PROPS -Encoding ASCII
(Get-Content $ENVF)  -replace '^CORS_ORIGINS=.*',    "CORS_ORIGINS=$crmUrl,http://localhost:81" |
    Set-Content $ENVF -Encoding ASCII

# ai-advisor.jsp caches the properties in a static (AI_PROPS), so the file has to be
# touched to force a recompile - otherwise the page keeps serving the old base-url.
(Get-Item $JSP).LastWriteTime = Get-Date
Write-Output '  touched ai-advisor.jsp (forces AI_PROPS reload)'

Write-Output 'Restarting sidecar...'
$listener = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
if ($listener) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList @(
        '--require', (Join-Path $SIDECAR 'node_modules\tsx\dist\preflight.cjs'),
        '--import',  ('file:///' + (Join-Path $SIDECAR 'node_modules\tsx\dist\loader.mjs') -replace '\\','/'),
        'src/server.ts'
    ) `
    -WorkingDirectory $SIDECAR `
    -RedirectStandardOutput (Join-Path $WORK 'sidecar.log') `
    -RedirectStandardError  (Join-Path $WORK 'sidecar.err.log') `
    -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds(40)
$up = $false
while ((Get-Date) -lt $deadline -and -not $up) {
    Start-Sleep -Milliseconds 700
    # curl.exe, not Invoke-WebRequest: IWR can ignore -TimeoutSec while it does
    # proxy autodetection and then hang the whole script indefinitely.
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 8 "$aiUrl/health" 2>$null
    $up = ($code -eq '200')
}

Write-Output ''
if ($up) {
    Write-Output '  READY'
} else {
    Write-Output ('  Sidecar did not answer /health in time - check ' + (Join-Path $WORK 'sidecar.err.log'))
}
Write-Output ''
# Send the /index.html form, not the bare host. Resin 3.1 ignores X-Forwarded-Proto,
# so the apex "/" -> "/index.html" redirect is emitted as http:// and drops the browser
# off HTTPS - which kills the secure context the mic needs and sends the login in the
# clear. Entering at /index.html skips that redirect; the rest of the app stays on https.
Write-Output "  Send testers:  $crmUrl/index.html"
Write-Output "  Sidecar:       $aiUrl"
Write-Output ''
Write-Output '  Use the /index.html link - the bare host redirects to http and loses HTTPS.'
Write-Output '  Both URLs change every time this script runs. Re-send after each restart.'

# The hidden child processes inherit this shell's stdout handle, so without an
# explicit exit the script sits at the prompt forever instead of returning.
exit 0
