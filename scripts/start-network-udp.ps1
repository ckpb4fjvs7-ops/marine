param([int]$Port = 8092, [string]$AllowOrigin = '')
$ErrorActionPreference = 'Stop'
$udpProject = Split-Path -Parent $PSScriptRoot
$udpNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$udpNodePath = if ($udpNodeCommand) { $udpNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $udpNodePath)) { throw 'Install Node.js 24, then run this file again.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be 1..65535.' }
$udpArguments = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'udp-bridge.mjs'), '--port', [string]$Port)
if ($AllowOrigin) { $udpArguments += @('--allow-origin', $AllowOrigin) }
Set-Location -LiteralPath $udpProject
& $udpNodePath @udpArguments
