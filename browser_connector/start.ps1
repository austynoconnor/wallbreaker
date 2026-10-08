param([switch]$Setup)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$python=Join-Path $root '.venv/Scripts/python.exe'
& $python -c 'from browser_connector.server import load_key; load_key()'
$env:MUSE_BROWSER_BRIDGE_KEY=[System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '.local/bridge.key')).Trim()
$ready=$false
try { $ready=(Invoke-RestMethod 'http://127.0.0.1:8788/health' -TimeoutSec 2).name -eq 'wallbreaker-muse-bridge' } catch {}
if (!$ready) {
    Start-Process -FilePath $python -ArgumentList '-m browser_connector.server' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot '.local/bridge.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot '.local/bridge.stderr.log') | Out-Null
}
if ($Setup) {
    Set-Clipboard -Value ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '.local/bridge.key')).Trim())
    Write-Host 'Pairing key copied. In Chrome extensions, enable Developer mode and choose Load unpacked.'
    Write-Host "Extension folder: $PSScriptRoot/extension"
    Write-Host 'Open a fresh Muse side chat. Click the connector, paste the key, and Connect.'
    Write-Host 'In Wallbreaker select target profile muse-browser. Keep Opus as the attacker and Haiku as judge.'
    Read-Host 'Press Enter to close'
}
