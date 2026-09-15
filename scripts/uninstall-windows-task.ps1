$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startupDir 'HotelAppServer.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir 'HotelAppTunnel.lnk') -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
	Where-Object { $_.CommandLine -like '*scripts\run-server.ps1*' -or $_.CommandLine -like '*scripts\run-tunnel.ps1*' } |
	ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Da go HotelAppServer khoi thu muc Startup.'