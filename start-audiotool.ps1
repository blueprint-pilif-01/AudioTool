$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$Ports = @(3000, 5173, 8000)

Set-Location -LiteralPath $ProjectRoot
$Host.UI.RawUI.WindowTitle = "AudioTool Launcher"

function Stop-WithError {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Test-CommandAvailable {
  param([Parameter(Mandatory = $true)][string]$Name)

  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Stop-PreviousAudioToolServices {
  Write-Host "Stopping previous AudioTool service windows..." -ForegroundColor Cyan
  $escapedRoot = [regex]::Escape($ProjectRoot)
  $launchers = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object {
    $_.CommandLine -match "title AudioTool (API|Web|ML Worker)" -or
    (
      $_.CommandLine -match $escapedRoot -and
      (
        $_.CommandLine -match "corepack pnpm --filter @audiotool/(api|web) dev" -or
        $_.CommandLine -match "audiotool_ml_worker\.main:app"
      )
    )
  }

  foreach ($launcher in $launchers) {
    & taskkill.exe /PID $launcher.ProcessId /T /F *> $null
  }

  Start-Sleep -Milliseconds 800

  foreach ($port in $Ports) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $belongsToProject =
        $null -ne $process -and
        (
          $process.CommandLine -match $escapedRoot -or
          ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase))
        )

      $ancestor = $process
      for ($depth = 0; -not $belongsToProject -and $null -ne $ancestor -and $depth -lt 8; $depth++) {
        $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
        $belongsToProject =
          $null -ne $ancestor -and
          (
            $ancestor.CommandLine -match $escapedRoot -or
            $ancestor.CommandLine -match "title AudioTool (API|Web|ML Worker)" -or
            ($ancestor.ExecutablePath -and $ancestor.ExecutablePath.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase))
          )
      }

      if ($belongsToProject) {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      } else {
        Stop-WithError "Port $port is already used by another program (PID $($listener.OwningProcess)). Close it and try again."
      }
    }
  }

  Start-Sleep -Milliseconds 500
}

function Start-ServiceWindow {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $fullCommand = "title $Title && $Command"
  Start-Process -FilePath $env:ComSpec -ArgumentList @("/d", "/k", $fullCommand) -WorkingDirectory $WorkingDirectory | Out-Null
}

function Wait-ForHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 45
  )

  Write-Host "Waiting for $Name..." -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = "No response received."

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 4
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        Write-Host "$Name is ready." -ForegroundColor Green
        return $true
      }
      $lastError = "HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
      if ($_.Exception.Response) {
        try {
          $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
          $body = $reader.ReadToEnd()
          $reader.Dispose()
          if ($body) { $lastError = $body }
        } catch {
          # Keep the original connection error.
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }

  Write-Host "$Name did not become ready: $lastError" -ForegroundColor Red
  return $false
}

if (-not (Test-CommandAvailable "node")) {
  Stop-WithError "Node.js 22 or newer is required. Run install-audiotool.bat once on this PC."
}

$nodeVersionText = (& node --version).Trim().TrimStart("v")
if ([version]$nodeVersionText -lt [version]"22.0.0") {
  Stop-WithError "Node.js 22 or newer is required. Found $nodeVersionText."
}

if (-not (Test-CommandAvailable "corepack")) {
  Stop-WithError "Corepack is missing. Run install-audiotool.bat, or reinstall Node.js 22."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".env"))) {
  Stop-WithError ".env is missing. Run install-audiotool.bat, or copy .env.example to .env and set DATABASE_URL."
}

$useDemucs = $null -ne (Select-String -Path (Join-Path $ProjectRoot ".env") -Pattern "^ML_PROVIDER=demucs_http$" -ErrorAction SilentlyContinue)
$workerRoot = Join-Path $ProjectRoot "apps\ml-worker"
$workerPython = Join-Path $workerRoot ".venv\Scripts\python.exe"

if ($useDemucs) {
  if (-not (Test-Path -LiteralPath $workerPython)) {
    Stop-WithError "The Demucs environment is missing at apps\ml-worker\.venv. Run install-audiotool.bat and choose Complete, or follow apps\ml-worker\README.md."
  }

  & $workerPython -c "import fastapi, uvicorn, torch, demucs" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError "The Demucs Python environment is incomplete. Follow apps\ml-worker\README.md."
  }
}

Stop-PreviousAudioToolServices

Write-Host "Checking JavaScript dependencies..." -ForegroundColor Cyan
& corepack pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  Stop-WithError "JavaScript dependencies could not be installed."
}

if ($useDemucs) {
  Start-ServiceWindow `
    -Title "AudioTool ML Worker" `
    -Command ".venv\Scripts\python.exe -m uvicorn audiotool_ml_worker.main:app --host 127.0.0.1 --port 8000" `
    -WorkingDirectory $workerRoot

  if (-not (Wait-ForHttp -Name "Demucs ML worker" -Url "http://127.0.0.1:8000/health" -TimeoutSeconds 45)) {
    Stop-WithError "Demucs failed to start. Check the 'AudioTool ML Worker' window."
  }
}

Start-ServiceWindow `
  -Title "AudioTool API" `
  -Command "corepack pnpm --filter @audiotool/api dev" `
  -WorkingDirectory $ProjectRoot

if (-not (Wait-ForHttp -Name "AudioTool API" -Url "http://127.0.0.1:3000/health" -TimeoutSeconds 45)) {
  Stop-WithError "The API failed to start. Check the 'AudioTool API' window."
}

if (-not (Wait-ForHttp -Name "AudioTool dependencies" -Url "http://127.0.0.1:3000/ready" -TimeoutSeconds 30)) {
  Stop-WithError "PostgreSQL, FFmpeg, storage, the queue, or the ML worker is unavailable. Check the API window."
}

Start-ServiceWindow `
  -Title "AudioTool Web" `
  -Command "corepack pnpm --filter @audiotool/web dev" `
  -WorkingDirectory $ProjectRoot

if (-not (Wait-ForHttp -Name "AudioTool web app" -Url "http://127.0.0.1:5173" -TimeoutSeconds 45)) {
  Stop-WithError "The web app failed to start. Check the 'AudioTool Web' window."
}

Write-Host ""
Write-Host "AudioTool is ready. Opening the browser..." -ForegroundColor Green
Start-Process "http://localhost:5173"
exit 0
