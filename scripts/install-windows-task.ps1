$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startupDir = [Environment]::GetFolderPath('Startup')
$serverShortcutPath = Join-Path $startupDir 'HotelAppServer.lnk'
$serverScriptPath = Join-Path $appDir 'scripts\run-server.ps1'
$tunnelShortcutPath = Join-Path $startupDir 'HotelAppTunnel.lnk'
$tunnelScriptPath = Join-Path $appDir 'scripts\run-tunnel.ps1'
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($serverShortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serverScriptPath`""
$shortcut.WorkingDirectory = $appDir
$shortcut.WindowStyle = 7
$shortcut.Description = 'Hotel app server'
$shortcut.Save()

$tunnelShortcut = $shell.CreateShortcut($tunnelShortcutPath)
$tunnelShortcut.TargetPath = $powershellPath
$tunnelShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tunnelScriptPath`""
$tunnelShortcut.WorkingDirectory = $appDir
$tunnelShortcut.WindowStyle = 7
$tunnelShortcut.Description = 'Hotel app Cloudflare tunnel'
$tunnelShortcut.Save()

Start-Process -FilePath $powershellPath -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $serverScriptPath) -WorkingDirectory $appDir
Start-Process -FilePath $powershellPath -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $tunnelScriptPath) -WorkingDirectory $appDir
Write-Host 'Da cai HotelAppServer va HotelAppTunnel vao thu muc Startup.'