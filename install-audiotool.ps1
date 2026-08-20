#requires -Version 5.1
<#
.SYNOPSIS
  Installs every runtime AudioTool needs on a new Windows PC and prepares this repo to launch.

.PARAMETER Mode
  Standard = app runs with mock stems.
  Complete = also installs Python + Demucs for real separation (several GB).

.PARAMETER PostgresPassword
  Password for the local postgres user. If omitted, the installer tries known local defaults
  and then prompts. A fresh winget PostgreSQL install uses "postgres" until it is rotated.

.PARAMETER Launch
  Start AudioTool when setup finishes.
#>
[CmdletBinding()]
param(
  [ValidateSet("Standard", "Complete")]
  [string]$Mode,
  [string]$PostgresPassword,
  [switch]$Launch
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$LogPath = Join-Path $ProjectRoot "install-audiotool.log"
$Host.UI.RawUI.WindowTitle = "AudioTool Installer"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ForwardedInstallerArgs {
  $forward = @()
  if ($Mode) { $forward += @("-Mode", $Mode) }
  if ($PostgresPassword) { $forward += @("-PostgresPassword", $PostgresPassword) }
  if ($Launch) { $forward += "-Launch" }
  return $forward
}

if (-not (Test-Administrator)) {
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath) + @(Get-ForwardedInstallerArgs)
  $elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList $argList
  if ($null -eq $elevated) { exit 1 }
  exit $elevated.ExitCode
}

Set-Location -LiteralPath $ProjectRoot
Start-Transcript -Path $LogPath -Force | Out-Null

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "    $Message" -ForegroundColor Green
}

function Write-Warn {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Stop-Installer {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  Write-Host "A full log is in $LogPath" -ForegroundColor Yellow
  try { Stop-Transcript | Out-Null } catch { }
  if ([Environment]::UserInteractive) {
    Write-Host ""
    Write-Host "Press Enter to close."
    [void][Console]::ReadLine()
  }
  exit 1
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Add-MachinePathEntry {
  param([Parameter(Mandatory = $true)][string]$Directory)
  if (-not (Test-Path -LiteralPath $Directory)) { return }
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $parts = $machine -split ";" | Where-Object { $_ -ne "" }
  $exists = $parts | Where-Object { $_.TrimEnd("\") -ieq $Directory.TrimEnd("\") }
  if ($exists) { return }
  [Environment]::SetEnvironmentVariable("Path", "$machine;$Directory", "Machine")
  Update-SessionPath
}

function Test-CommandAvailable {
  param([Parameter(Mandatory = $true)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Find-CommandPath {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  return $command.Source
}

function ConvertFrom-SecureText {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Secret)
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function New-RandomToken {
  param([int]$Bytes = 48)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  return [Convert]::ToBase64String($buffer)
}

function Get-DotEnvMap {
  param([Parameter(Mandatory = $true)][string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
    $pair = $line.Split("=", 2)
    if ($pair.Count -eq 2) { $map[$pair[0].Trim()] = $pair[1] }
  }
  return $map
}

function Write-DefaultEnvFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [Parameter(Mandatory = $true)][string]$MlProvider,
    [string]$YtDlpPath = "yt-dlp"
  )
  $content = @"
DATABASE_URL=$DatabaseUrl
API_HOST=127.0.0.1
API_PORT=3000
WEB_ORIGIN=http://localhost:5173
VITE_API_URL=
INTERNAL_API_KEY=$ApiKey
DEV_INTERNAL_USER_ID=1
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=./storage
MAX_UPLOAD_BYTES=524288000
MAX_AUDIO_DURATION_MS=7200000
MAX_PROJECTS_PER_USER=100
MAX_STORAGE_BYTES_PER_USER=10737418240
MAX_CONCURRENT_JOBS_PER_USER=1
API_RATE_LIMIT_MAX=120
API_RATE_LIMIT_WINDOW_MS=60000
TEMP_FILE_TTL_HOURS=24
PROJECT_RETENTION_DAYS=30
CLEANUP_INTERVAL_MINUTES=60
QUEUE_MODE=inline
REDIS_URL=redis://localhost:6379
ML_PROVIDER=$MlProvider
ML_WORKER_URL=http://localhost:8000
ML_REQUEST_TIMEOUT_MS=1800000
GUIDE_TTS_PROVIDER=auto
GROQ_API_KEY=
GROQ_TTS_MODEL=canopylabs/orpheus-v1-english
GROQ_TTS_VOICE=hannah
AUDIOTOOL_ML_MODEL=htdemucs_6s
AUDIOTOOL_ML_VOCAL_MODEL=htdemucs_ft
AUDIOTOOL_ML_CACHE_ROOT=./ml-cache
AUDIOTOOL_ML_MAX_UPLOAD_BYTES=524288000
AUDIOTOOL_ML_TIMEOUT_SECONDS=1800
AUDIOTOOL_ML_CONCURRENCY=1
AUDIOTOOL_ML_SHIFTS=0
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
TEMP_ROOT=./tmp
VIRUS_SCAN_MODE=disabled
CLAMSCAN_PATH=clamscan
VIRUS_SCAN_TIMEOUT_MS=120000
YTDLP_PATH=$YtDlpPath
"@
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $content.TrimStart() + "`n", $utf8)
}

function Set-DotEnvValues {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Values
  )
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $Path) {
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) { $lines.Add($line) }
  }
  foreach ($key in $Values.Keys) {
    $replaced = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
      if ($lines[$index] -match ("^" + [regex]::Escape($key) + "=")) {
        $lines[$index] = "$key=$($Values[$key])"
        $replaced = $true
        break
      }
    }
    if (-not $replaced) { $lines.Add("$key=$($Values[$key])") }
  }
  [System.IO.File]::WriteAllLines($Path, $lines, $utf8)
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string[]]$ExtraArgs
  )
  Write-Host "    Installing $Id via winget..."
  $wingetArgs = @(
    "install", "--id", $Id, "-e",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity"
  )
  if ($ExtraArgs) { $wingetArgs += $ExtraArgs }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & winget @wingetArgs
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  # 0 success, -1978335189 already installed, -1978335135 no upgrade available
  if ($code -eq 0 -or $code -eq -1978335189 -or $code -eq -1978335135) {
    Update-SessionPath
    return
  }
  throw "winget could not install $Id (exit code $code)."
}

function Wait-ForService {
  param(
    [Parameter(Mandatory = $true)][string]$NamePattern,
    [int]$TimeoutSeconds = 90
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $service = Get-Service | Where-Object { $_.Name -like $NamePattern } | Select-Object -First 1
    if ($null -ne $service) {
      if ($service.Status -ne "Running") {
        try { Start-Service -Name $service.Name } catch { }
      }
      $service.Refresh()
      if ($service.Status -eq "Running") { return $service }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Find-PostgresBin {
  $fromPath = Find-CommandPath "psql"
  if ($fromPath) { return (Split-Path -Parent $fromPath) }
  $versions = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Name -replace "\D", "0") } -Descending
  foreach ($version in $versions) {
    $bin = Join-Path $version.FullName "bin"
    if (Test-Path -LiteralPath (Join-Path $bin "psql.exe")) { return $bin }
  }
  return $null
}

function Test-PostgresLogin {
  param(
    [Parameter(Mandatory = $true)][string]$Psql,
    [Parameter(Mandatory = $true)][string]$Password
  )
  $previousPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $previous = $env:PGPASSWORD
  $env:PGPASSWORD = $Password
  try {
    $output = & $Psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -tAc "select 1" 2>&1
    return ($LASTEXITCODE -eq 0 -and ("$output").Trim() -eq "1")
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousPref
    if ($null -eq $previous) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $previous }
  }
}

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)][string]$Psql,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string]$Sql,
    [string]$Database = "postgres"
  )
  $previousPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $previous = $env:PGPASSWORD
  $env:PGPASSWORD = $Password
  try {
    $output = & $Psql -U postgres -h 127.0.0.1 -p 5432 -d $Database -v ON_ERROR_STOP=1 -tAc $Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "psql failed: $output"
    }
    return ("$output").Trim()
  } finally {
    $ErrorActionPreference = $previousPref
    if ($null -eq $previous) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $previous }
  }
}

function New-Shortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target
  )
  $folder = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $folder)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.WindowStyle = 1
  $shortcut.Description = "Start AudioTool"
  $shortcut.Save()
}

try {
  Write-Host ""
  Write-Host "AudioTool installer" -ForegroundColor White
  Write-Host "This prepares a new Windows PC so the app in this folder can run."
  Write-Host "Project: $ProjectRoot"

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json"))) {
    Stop-Installer "Run this installer from the AudioTool repository root."
  }
  if (-not (Test-CommandAvailable "winget")) {
    Stop-Installer "winget is missing. Install 'App Installer' from the Microsoft Store, then re-run install-audiotool.bat."
  }

  if (-not $Mode) {
    Write-Host ""
    Write-Host "Install real Demucs stem separation as well?"
    Write-Host "  Y = Python 3.13 + PyTorch + Demucs (several GB, 10-30 minutes). Actual stems."
    Write-Host "  N = App runs immediately with mock stems. You can re-run later with -Mode Complete."
    $choice = Read-Host "Choice [Y/N]"
    if ($choice -match "^[Nn]") { $Mode = "Standard" }
    else { $Mode = "Complete" }
  }

  Write-Step "Enabling Windows long paths"
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force | Out-Null
  Write-Ok "Long path support is on."

  Write-Step "Installing Visual C++ runtime"
  Install-WingetPackage -Id "Microsoft.VCRedist.2015+.x64"
  Write-Ok "Visual C++ 2015-2022 x64 is present."

  Write-Step "Installing Node.js 22"
  $nodeOk = $false
  if (Test-CommandAvailable "node") {
    $found = (& node --version).Trim().TrimStart("v")
    if ([version]$found -ge [version]"22.0.0") { $nodeOk = $true }
  }
  if (-not $nodeOk) {
    Install-WingetPackage -Id "OpenJS.NodeJS.22"
    Update-SessionPath
    if (-not (Test-CommandAvailable "node")) {
      Add-MachinePathEntry "C:\Program Files\nodejs"
    }
  }
  if (-not (Test-CommandAvailable "node")) {
    Stop-Installer "Node.js was installed but is not on PATH. Close this window and run the installer again."
  }
  $nodeVersion = (& node --version).Trim()
  if ([version]($nodeVersion.TrimStart("v")) -lt [version]"22.0.0") {
    Stop-Installer "Node.js 22 or newer is required. Found $nodeVersion."
  }
  Write-Ok "Node $nodeVersion"

  Write-Step "Enabling pnpm via Corepack"
  if (-not (Test-CommandAvailable "corepack")) {
    Stop-Installer "Corepack is missing. Reinstall Node.js 22."
  }
  & corepack enable
  & corepack prepare pnpm@11.9.0 --activate
  if ($LASTEXITCODE -ne 0) { Stop-Installer "Corepack could not activate pnpm 11.9.0." }
  Write-Ok (& corepack pnpm --version)

  Write-Step "Installing FFmpeg"
  if (-not ((Test-CommandAvailable "ffmpeg") -and (Test-CommandAvailable "ffprobe"))) {
    Install-WingetPackage -Id "Gyan.FFmpeg"
    Update-SessionPath
    $ffmpegExe = Find-CommandPath "ffmpeg"
    if (-not $ffmpegExe) {
      $searchRoots = @(
        "C:\ffmpeg",
        "C:\Program Files\ffmpeg",
        "C:\Program Files\Gyan",
        "C:\Program Files\WinGet\Packages"
      )
      foreach ($root in $searchRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $hit = Get-ChildItem -Path $root -Filter "ffmpeg.exe" -Recurse -ErrorAction SilentlyContinue |
          Select-Object -First 1
        if ($hit) {
          Add-MachinePathEntry $hit.DirectoryName
          break
        }
      }
    } else {
      Add-MachinePathEntry (Split-Path -Parent $ffmpegExe)
    }
    Update-SessionPath
  }
  if (-not ((Test-CommandAvailable "ffmpeg") -and (Test-CommandAvailable "ffprobe"))) {
    Stop-Installer "FFmpeg/ffprobe are not on PATH after installation."
  }
  Write-Ok ((& ffmpeg -version | Select-Object -First 1).ToString().Trim())

  Write-Step "Installing yt-dlp"
  try {
    if (-not (Test-CommandAvailable "yt-dlp")) {
      Install-WingetPackage -Id "yt-dlp.yt-dlp"
    }
    if (Test-CommandAvailable "yt-dlp") { Write-Ok "yt-dlp is on PATH." }
    else { Write-Warn "yt-dlp was not added to PATH. YouTube import may still work via youtube-dl-exec." }
  } catch {
    Write-Warn "yt-dlp could not be installed. YouTube import may be unavailable."
  }

  Write-Step "Installing PostgreSQL 18"
  $installedPostgresThisRun = $false
  $pgBin = Find-PostgresBin
  if (-not $pgBin) {
    Install-WingetPackage -Id "PostgreSQL.PostgreSQL.18"
    $installedPostgresThisRun = $true
    $service = Wait-ForService -NamePattern "postgresql*"
    if ($null -eq $service) {
      Stop-Installer "PostgreSQL installed but the Windows service did not start."
    }
    $pgBin = Find-PostgresBin
  }
  if (-not $pgBin) { Stop-Installer "psql.exe was not found after installing PostgreSQL." }
  Add-MachinePathEntry $pgBin
  $psql = Join-Path $pgBin "psql.exe"
  $pgService = Wait-ForService -NamePattern "postgresql*"
  if ($null -eq $pgService) { Stop-Installer "The PostgreSQL service is not running." }
  Write-Ok "Using $psql"

  Write-Step "Creating the audio_tool database"
  $envFile = Join-Path $ProjectRoot ".env"
  $existingEnv = Get-DotEnvMap -Path $envFile
  $passwordsToTry = New-Object System.Collections.Generic.List[string]
  if ($PostgresPassword) { [void]$passwordsToTry.Add($PostgresPassword) }
  if ($existingEnv["DATABASE_URL"] -match "postgresql://[^:]+:([^@]+)@") {
    $fromUrl = [uri]::UnescapeDataString($Matches[1])
    if ($fromUrl) { [void]$passwordsToTry.Add($fromUrl) }
  }
  [void]$passwordsToTry.Add("postgres")

  $workingPassword = $null
  foreach ($candidate in $passwordsToTry) {
    if (Test-PostgresLogin -Psql $psql -Password $candidate) {
      $workingPassword = $candidate
      break
    }
  }
  if (-not $workingPassword) {
    $typed = Read-Host "Enter the local PostgreSQL password for user 'postgres'" -AsSecureString
    $workingPassword = ConvertFrom-SecureText $typed
    if (-not (Test-PostgresLogin -Psql $psql -Password $workingPassword)) {
      Stop-Installer "Could not connect to PostgreSQL as postgres. Check the password and that port 5432 is free."
    }
  }

  $finalPassword = $workingPassword
  if ($installedPostgresThisRun -and $workingPassword -eq "postgres") {
    $finalPassword = New-RandomToken -Bytes 18
    $escaped = $finalPassword.Replace("'", "''")
    Invoke-Psql -Psql $psql -Password $workingPassword -Sql "ALTER USER postgres PASSWORD '$escaped';" | Out-Null
    if (-not (Test-PostgresLogin -Psql $psql -Password $finalPassword)) {
      $finalPassword = $workingPassword
      Write-Warn "Could not rotate the default postgres password; keeping the winget default in .env."
    } else {
      Write-Ok "Rotated the local postgres password and stored it in .env."
    }
  }

  $exists = Invoke-Psql -Psql $psql -Password $finalPassword -Sql "SELECT 1 FROM pg_database WHERE datname = 'audio_tool'"
  if ($exists -ne "1") {
    Invoke-Psql -Psql $psql -Password $finalPassword -Sql "CREATE DATABASE audio_tool ENCODING 'UTF8'" | Out-Null
    Write-Ok "Created database audio_tool."
  } else {
    Write-Ok "Database audio_tool already exists."
  }

  Write-Step "Writing .env"
  $mlProvider = "mock"
  if ($Mode -eq "Complete") { $mlProvider = "demucs_http" }
  $ytDlp = Find-CommandPath "yt-dlp"
  if (-not $ytDlp) { $ytDlp = "yt-dlp" }
  else { $ytDlp = $ytDlp.Replace("\", "/") }
  $databaseUrl = "postgresql://postgres:$([uri]::EscapeDataString($finalPassword))@127.0.0.1:5432/audio_tool"
  if (-not (Test-Path -LiteralPath $envFile)) {
    $apiKey = New-RandomToken -Bytes 48
    Write-DefaultEnvFile -Path $envFile -DatabaseUrl $databaseUrl -ApiKey $apiKey -MlProvider $mlProvider -YtDlpPath $ytDlp
    Write-Ok ".env was created with a local database URL and a new API key."
  } else {
    $envValues = Get-DotEnvMap -Path $envFile
    $apiKey = $envValues["INTERNAL_API_KEY"]
    if (-not $apiKey -or $apiKey.Length -lt 32 -or $apiKey -eq "replace-with-at-least-32-random-characters") {
      $apiKey = New-RandomToken -Bytes 48
    }
    Set-DotEnvValues -Path $envFile -Values @{
      DATABASE_URL = $databaseUrl
      INTERNAL_API_KEY = $apiKey
      DEV_INTERNAL_USER_ID = "1"
      ML_PROVIDER = $mlProvider
      YTDLP_PATH = $ytDlp
    }
    Write-Ok "Updated the existing .env with database and API credentials."
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "storage") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "tmp") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "ml-cache") | Out-Null

  Write-Step "Allowing Windows Defender to skip this project folder"
  try {
    Add-MpPreference -ExclusionPath $ProjectRoot -ErrorAction Stop
    Write-Ok "Defender exclusion added for $ProjectRoot"
  } catch {
    Write-Warn "Could not add a Defender exclusion. pnpm install may be slower."
  }

  Write-Step "Installing JavaScript workspace packages"
  & corepack pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Frozen lockfile install failed; retrying without --frozen-lockfile."
    & corepack pnpm install
  }
  if ($LASTEXITCODE -ne 0) { Stop-Installer "pnpm install failed. Check the log and your network." }
  Write-Ok "JavaScript dependencies are installed."

  Write-Step "Applying database migrations"
  & corepack pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { Stop-Installer "Database migration failed. See install-audiotool.log." }
  Write-Ok "Migrations applied."

  if ($Mode -eq "Complete") {
    Write-Step "Installing Python 3.13 and the Demucs worker"
    Write-Warn "This step downloads PyTorch and can take a long time."
    try {
      $previousPref = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      $pythonOk = $false
      if (Test-CommandAvailable "py") {
        & py -3.13 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $pythonOk = $true }
      }
      if (-not $pythonOk) {
        Install-WingetPackage -Id "Python.Python.3.13" -ExtraArgs @("--scope", "machine")
        Update-SessionPath
      }
      if (-not (Test-CommandAvailable "py")) {
        throw "The Python launcher (py.exe) is missing after installing Python 3.13."
      }
      $workerRoot = Join-Path (Join-Path $ProjectRoot "apps") "ml-worker"
      $venvPython = Join-Path (Join-Path (Join-Path $workerRoot ".venv") "Scripts") "python.exe"
      if (-not (Test-Path -LiteralPath $venvPython)) {
        & py -3.13 -m venv (Join-Path $workerRoot ".venv")
        if ($LASTEXITCODE -ne 0) { throw "Could not create apps\ml-worker\.venv." }
      }
      & $venvPython -m pip install --upgrade pip
      if ($LASTEXITCODE -ne 0) { throw "pip could not be upgraded in the ML virtual environment." }
      Push-Location $workerRoot
      try {
        & $venvPython -m pip install -e .
        if ($LASTEXITCODE -ne 0) { throw "pip install of the Demucs worker failed." }
      } finally {
        Pop-Location
      }
      & $venvPython -c "import fastapi, uvicorn, torch, demucs"
      if ($LASTEXITCODE -ne 0) { throw "The Demucs environment is missing required packages." }
      $ErrorActionPreference = $previousPref
      Write-Ok "Demucs worker environment is ready. The first real job will download model weights."
    } catch {
      $ErrorActionPreference = "Stop"
      Write-Warn "Real Demucs setup failed: $($_.Exception.Message)"
      Write-Warn "AudioTool will still run with mock stems. Re-run later with -Mode Complete."
      Set-DotEnvValues -Path $envFile -Values @{ ML_PROVIDER = "mock" }
      $Mode = "Standard"
    }
  }

  Write-Step "Creating shortcuts"
  $launcher = Join-Path $ProjectRoot "start-audiotool.bat"
  $desktop = [Environment]::GetFolderPath("Desktop")
  $startMenu = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\AudioTool"
  New-Shortcut -Path (Join-Path $desktop "AudioTool.lnk") -Target $launcher
  New-Shortcut -Path (Join-Path $startMenu "AudioTool.lnk") -Target $launcher
  Write-Ok "Desktop and Start Menu shortcuts point at start-audiotool.bat."

  Write-Host ""
  Write-Host "AudioTool is installed." -ForegroundColor Green
  Write-Host "Start it with start-audiotool.bat, the Desktop shortcut, or the Start Menu entry."
  Write-Host "Web UI: http://localhost:5173"
  Write-Host "API:    http://localhost:3000"
  if ($Mode -eq "Standard") {
    Write-Host "Stem separation is mock until you re-run: powershell -File install-audiotool.ps1 -Mode Complete"
  }

  $shouldLaunch = [bool]$Launch
  if (-not $Launch -and [Environment]::UserInteractive) {
    $startNow = Read-Host "Start AudioTool now? [Y/N]"
    $shouldLaunch = $startNow -notmatch "^[Nn]"
  }
  if ($shouldLaunch) {
    Write-Host "Launching AudioTool..."
    Start-Process -FilePath (Join-Path $ProjectRoot "start-audiotool.bat")
  }
} catch {
  Stop-Installer $_.Exception.Message
} finally {
  try { Stop-Transcript | Out-Null } catch { }
}

if ([Environment]::UserInteractive -and -not $Launch) {
  Write-Host ""
  Write-Host "Press Enter to close."
  [void][Console]::ReadLine()
}
exit 0
