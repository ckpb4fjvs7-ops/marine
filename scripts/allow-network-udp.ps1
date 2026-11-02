param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$SourceIp)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'UDP Port must be 1..65535.' }
$udpParsedAddress = $null
if (-not [Net.IPAddress]::TryParse($SourceIp, [ref]$udpParsedAddress) -or $udpParsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $SourceIp -eq '0.0.0.0' -or [int]$SourceIp.Split('.')[0] -ge 224) { throw 'Provide the actual IPv4 address of the R5 source.' }
$udpIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$udpPrincipal = [Security.Principal.WindowsPrincipal]::new($udpIdentity)
if (-not $udpPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator to add this narrow firewall rule.' }
$udpNodePath = $null
foreach ($udpEndpoint in @(Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue)) {
  $udpProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($udpEndpoint.OwningProcess)" -ErrorAction SilentlyContinue
  if ($udpProcessInfo.CommandLine -match 'udp-bridge\.mjs' -and $udpProcessInfo.ExecutablePath) { $udpNodePath = $udpProcessInfo.ExecutablePath; break }
}
if (-not $udpNodePath) {
  $udpNodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $udpNodePath = if ($udpNodeCommand) { $udpNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
}
if (-not (Test-Path -LiteralPath $udpNodePath)) { throw 'Node.js was not found.' }
$udpRuleName = "MARINE360-UDP-$Port-$SourceIp"
if (-not (Get-NetFirewallRule -Name $udpRuleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name $udpRuleName -DisplayName "MARINE 360 UDP $Port from $SourceIp" -Direction Inbound -Action Allow -Protocol UDP -LocalPort $Port -RemoteAddress $SourceIp -Program $udpNodePath -Profile Any | Out-Null
}
Write-Output "Allowed inbound UDP $Port only from $SourceIp to $udpNodePath."
