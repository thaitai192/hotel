$ErrorActionPreference = 'Continue'
$appDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cloudflaredPath = Join-Path $appDir 'cloudflared.exe'
$tunnelId = '281990be-ea78-4a6e-9fb6-5ea1e0209695'

Set-Location $appDir
while ($true) {
  & $cloudflaredPath tunnel run --url http://localhost:3000 $tunnelId
  Start-Sleep -Seconds 5
}