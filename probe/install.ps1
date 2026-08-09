# Celerity Probe installer (Windows service).
#
# Usage (run in an elevated PowerShell, the panel generates this line with a
# single-use token):
#   $env:PANEL_URL='https://panel'; $env:ENROLL_TOKEN='ce_...'; irm .../celerity-probe-install.ps1 | iex
#
# Installs the probe binary, fetches a sing-box core, enrolls once and registers
# a Windows service. The probe needs no privileges on any node: it only holds
# client subscription credentials.

$ErrorActionPreference = 'Stop'

$PanelUrl = $env:PANEL_URL
$EnrollToken = $env:ENROLL_TOKEN
$DataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { "$env:ProgramData\celerity-probe" }
$ReleaseBase = if ($env:RELEASE_BASE) { $env:RELEASE_BASE } else { 'https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download' }

if (-not $PanelUrl -or -not $EnrollToken) {
    throw 'PANEL_URL and ENROLL_TOKEN are required'
}

# The probe token and every measurement travel over this URL. Plain HTTP would
# hand both to anyone on the path, so it is only allowed against a loopback
# panel and only when explicitly requested.
if ($PanelUrl -notmatch '^https://' -and
    $PanelUrl -notmatch '^http://(127\.0\.0\.1|localhost)([:/]|$)' -and
    $env:PROBE_ALLOW_INSECURE -ne '1') {
    throw 'PANEL_URL must use https (set PROBE_ALLOW_INSECURE=1 to override)'
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in an elevated PowerShell'
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'amd64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported architecture $env:PROCESSOR_ARCHITECTURE" }
}

Write-Host "==> Installing celerity-probe (windows/$arch)"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# The data directory holds the probe token and the core config with live
# subscription credentials. Under ProgramData every authenticated user can read
# by default, so inheritance is dropped and access limited to SYSTEM and admins.
$acl = Get-Acl $DataDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
foreach ($principal in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $DataDir -AclObject $acl

$probeExe = Join-Path $DataDir 'celerity-probe.exe'
$probeUrl = "$ReleaseBase/celerity-probe-windows-$arch.exe"
Write-Host "==> Downloading $probeUrl"
Invoke-WebRequest -Uri $probeUrl -OutFile $probeExe -UseBasicParsing

$singboxExe = Join-Path $DataDir 'sing-box.exe'
if (-not (Test-Path $singboxExe)) {
    # The core is downloaded from its own upstream release. Asset names carry
    # the version, so the exact URL is resolved through the releases API.
    Write-Host '==> Resolving latest sing-box release'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/SagerNet/sing-box/releases/latest' -UseBasicParsing
    $asset = $release.assets | Where-Object { $_.name -like "sing-box-*-windows-$arch.zip" } | Select-Object -First 1
    if (-not $asset) { throw 'Could not resolve a sing-box download URL' }

    Write-Host "==> Downloading $($asset.browser_download_url)"
    $tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'sing-box.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $found = Get-ChildItem -Path $tmp -Recurse -Filter 'sing-box.exe' | Select-Object -First 1
    if (-not $found) { throw 'sing-box extraction failed' }
    Copy-Item $found.FullName $singboxExe -Force
    Remove-Item $tmp -Recurse -Force
}

Write-Host "==> Enrolling with $PanelUrl"
# The token goes through the environment, never through the command line: the
# process table is readable by other users and the token is a live credential.
& $probeExe -dir $DataDir -panel $PanelUrl
if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed' }

$service = Get-Service -Name 'CelerityProbe' -ErrorAction SilentlyContinue
if ($service) {
    Stop-Service -Name 'CelerityProbe' -Force -ErrorAction SilentlyContinue
    sc.exe delete CelerityProbe | Out-Null
    Start-Sleep -Seconds 2
}

New-Service -Name 'CelerityProbe' `
    -DisplayName 'Celerity Probe' `
    -Description 'External diagnostic probe for Celerity panel' `
    -BinaryPathName "`"$probeExe`" -dir `"$DataDir`"" `
    -StartupType Automatic | Out-Null

Start-Service -Name 'CelerityProbe'

Write-Host "==> Done. Data directory: $DataDir"
