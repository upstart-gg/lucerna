# lucerna installer — Windows (PowerShell)
#
# Usage (one-liner):
#   irm https://raw.githubusercontent.com/upstart-gg/lucerna/main/install/install.ps1 | iex
#
# Environment overrides:
#   $env:INSTALL_DIR   — where to install the binary (default: $env:LOCALAPPDATA\lucerna)
#   $env:LUCERNA_TAG   — specific release tag to install (default: latest)

$ErrorActionPreference = 'Stop'

$Repo   = 'upstart-gg/lucerna'
$Binary = 'lucerna-windows-x64.exe'
$ExeName = 'lucerna.exe'

# ── Install directory ──────────────────────────────────────────────────────────

$InstallDir = if ($env:INSTALL_DIR) {
  $env:INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'lucerna'
}

# ── Resolve release tag ────────────────────────────────────────────────────────

$Tag = if ($env:LUCERNA_TAG) {
  $env:LUCERNA_TAG
} else {
  Write-Host "→  Fetching latest release…" -ForegroundColor Cyan
  $ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"
  $Release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing
  $Release.tag_name
}

if (-not $Tag) {
  Write-Error "Could not determine the latest release tag."
  exit 1
}

$DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Binary"

# ── Download ───────────────────────────────────────────────────────────────────

Write-Host "→  Downloading $Binary ($Tag)…" -ForegroundColor Cyan

$TmpFile = Join-Path ([System.IO.Path]::GetTempPath()) $Binary

try {
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpFile -UseBasicParsing
} catch {
  Write-Error "Download failed: $DownloadUrl`n$_"
  exit 1
}

# ── Install ────────────────────────────────────────────────────────────────────

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$Dest = Join-Path $InstallDir $ExeName
Move-Item -Path $TmpFile -Destination $Dest -Force

Write-Host "✓  Installed to $Dest" -ForegroundColor Green

# ── Add to PATH (user scope, persistent) ──────────────────────────────────────

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathDirs  = $UserPath -split ';' | Where-Object { $_ -ne '' }

if ($PathDirs -notcontains $InstallDir) {
  $NewPath = ($PathDirs + $InstallDir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')

  # Also update the current session so the next line can find the binary
  $env:Path = "$env:Path;$InstallDir"

  Write-Host "✓  Added $InstallDir to your user PATH" -ForegroundColor Green
  Write-Host ""
  Write-Host "!  Restart your terminal (or open a new PowerShell window) for the PATH" -ForegroundColor Yellow
  Write-Host "   change to take effect in other sessions." -ForegroundColor Yellow
}

# ── Verify ─────────────────────────────────────────────────────────────────────

try {
  $Version = & $Dest --version 2>$null
  Write-Host ""
  Write-Host "✓  lucerna $Version is ready." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "✓  Installation complete. Run 'lucerna' after restarting your terminal." -ForegroundColor Green
}
