$ErrorActionPreference = 'Continue'
$appDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

Set-Location $appDir
while ($true) {
  & $nodePath server.js
  Start-Sleep -Seconds 5
}