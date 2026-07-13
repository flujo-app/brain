<#
.SYNOPSIS
    brain installer / updater for Windows.

.DESCRIPTION
    Installs the prerequisites for the mode you pick, refreshes the environment
    (PATH) for the current session so new tools are usable immediately, clones
    (or updates) brain, prepares it, registers a global 'brain' command (start
    brain from any folder), and optionally starts it.

    Two modes:

      docker      The full experience: lobby, grow-a-brain wizard, one isolated
                  FLUJO per brain, Ollama for local models. Needs Git and
                  Docker Desktop (both installed via winget if missing).

      standalone  One brain, no Docker: same-origin proxy, live execution
                  animation, brain-stem tools. Needs Git and Node.js (both
                  installed via winget if missing).

    Designed to be run either directly:

        powershell -ExecutionPolicy Bypass -File scripts\install.ps1

    or as a one-liner straight from GitHub:

        irm https://raw.githubusercontent.com/flujo-app/brain/main/scripts/install.ps1 | iex

    When run as a one-liner it will interactively ask for the mode and the
    install folder (default: %LOCALAPPDATA%\brain) and whether to start brain
    afterwards. Re-running the installer on an existing install updates it.

.NOTES
    Parameters only take effect when the script is run as a file. When piped
    through `iex` the script falls back to interactive prompts (or the
    BRAIN_DIR / BRAIN_MODE / BRAIN_BRANCH / BRAIN_START / BRAIN_SHORTCUT /
    BRAIN_SET_POLICY environment variables if they are set).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $env:BRAIN_DIR,
    [string]$Branch     = $(if ($env:BRAIN_BRANCH) { $env:BRAIN_BRANCH } else { 'main' }),
    [string]$Mode       = $env:BRAIN_MODE,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/flujo-app/brain'

# On a fresh Windows the user's execution policy defaults to 'Restricted', which
# blocks running .ps1 files. The `irm ... | iex` one-liner is unaffected (iex
# evaluates a string), but `npm` is a PowerShell shim (npm.ps1) and fails with
# "running scripts is disabled on this system". Relax the policy for THIS PROCESS
# unconditionally so the install below always completes. This does not persist.
try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction Stop
} catch {
    # Process scope cannot override a Group-Policy-locked machine; in that rare
    # case the persistent prompt below (and a reopened admin terminal) is needed.
}

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Refresh the CURRENT session's environment from the Machine + User registry
# hives, so tools just installed by winget (git, docker, node, ...) are usable
# in this same session without reopening the terminal. winget writes the new
# PATH entries to the registry during install; this re-reads them.
function Update-SessionEnvironment {
    $pathSep = [System.IO.Path]::PathSeparator   # ';' on Windows

    # Preserve PATH entries already added to the live process, so a registry
    # refresh does not drop them.
    $processPath = $env:Path

    # Apply Machine-level then User-level vars (User wins). PATH is handled
    # separately below because it must be MERGED, not overwritten.
    foreach ($level in 'Machine', 'User') {
        $vars = [Environment]::GetEnvironmentVariables($level)
        foreach ($name in $vars.Keys) {
            if ($name -ieq 'Path') { continue }
            try { Set-Item -LiteralPath "Env:\$name" -Value $vars[$name] -ErrorAction Stop } catch { }
        }
    }

    # PATH = Machine + User + existing process PATH, de-duplicated, order preserved.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $seen = @{}
    $merged = foreach ($p in (@($machinePath, $userPath, $processPath) -join $pathSep).Split($pathSep)) {
        $t = $p.Trim()
        if ($t -and -not $seen.ContainsKey($t)) { $seen[$t] = $true; $t }
    }
    $env:Path = $merged -join $pathSep
}

# Install a package via winget only if the given command is missing.
function Install-Prereq {
    param(
        [string]$CommandName,
        [string]$WingetId,
        [string]$DisplayName
    )
    # Record whether the command was already on the system BEFORE we touch it, so
    # a future uninstaller can default to removing only what brain installed.
    $preexisting = Test-Command $CommandName
    if ($preexisting) {
        Write-Ok "$DisplayName already installed ($((Get-Command $CommandName).Source))"
    } else {
        Write-Step "Installing $DisplayName via winget ($WingetId)"
        # Pipe to Out-Host so winget's stdout goes to the console and does NOT leak
        # into this function's return value (which the caller captures as the
        # prerequisite record for the install manifest).
        winget install --id $WingetId -e --source winget `
            --accept-source-agreements --accept-package-agreements | Out-Host
        Update-SessionEnvironment
        if (Test-Command $CommandName) {
            Write-Ok "$DisplayName installed."
        } else {
            Write-Warn2 "$DisplayName installed but '$CommandName' is not yet on PATH. You may need to reopen the terminal."
        }
    }
    return [PSCustomObject]@{
        Command     = $CommandName
        WingetId    = $WingetId
        DisplayName = $DisplayName
        Preexisting = $preexisting
    }
}

# --- Docker helpers ----------------------------------------------------------

# 'docker' on PATH only means the CLI exists; the daemon (Docker Desktop) must
# actually be running for compose to work.
function Test-DockerDaemon {
    if (-not (Test-Command 'docker')) { return $false }
    # In Windows PowerShell 5.1 with ErrorActionPreference=Stop, redirecting a
    # native command's stderr turns its error output into terminating errors -
    # exactly what happens while the daemon is still starting. Relax the
    # preference around the probe so it can return $false instead of throwing.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        docker info 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Start-DockerDesktop {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    foreach ($exe in $candidates) {
        if (Test-Path -LiteralPath $exe) {
            Start-Process -FilePath $exe
            return $true
        }
    }
    return $false
}

function Wait-DockerDaemon([int]$TimeoutSec = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerDaemon) { return $true }
        Start-Sleep -Seconds 5
    }
    return (Test-DockerDaemon)
}

# --- Launcher / shortcut / manifest ------------------------------------------

# Create a global 'brain' command so brain can be started from any folder by
# typing `brain`. Writes a tiny launcher to a bin dir on the user's PATH, with
# the chosen install location and mode baked in.
function Register-BrainCommand {
    param([string]$AppDir, [string]$InstallMode)

    $binDir = Join-Path $env:LOCALAPPDATA 'brain-cli'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null

    $launcher = Join-Path $binDir 'brain.cmd'
    if ($InstallMode -eq 'docker') {
        $cmd = @"
@echo off
REM brain launcher (docker mode) - generated by install.ps1
set "BRAIN_HOME=$AppDir"
if not exist "%BRAIN_HOME%\docker-compose.yml" (
  echo brain was not found at "%BRAIN_HOME%". Please re-run the installer.
  exit /b 1
)
cd /d "%BRAIN_HOME%"
echo Starting brain (docker compose up -d) ...
docker compose up -d
if errorlevel 1 (
  echo Could not start the stack. Is Docker Desktop running?
  exit /b 1
)
echo brain:        http://localhost:8080
echo FLUJO editor: http://localhost:4200
start "" http://localhost:8080
"@
    } else {
        $cmd = @"
@echo off
REM brain launcher (standalone mode) - generated by install.ps1
set "BRAIN_HOME=$AppDir"
if not exist "%BRAIN_HOME%\package.json" (
  echo brain was not found at "%BRAIN_HOME%". Please re-run the installer.
  exit /b 1
)
cd /d "%BRAIN_HOME%"
echo Starting brain (standalone) - it builds first, then serves http://localhost:8080
start "" http://localhost:8080
npm run standalone %*
"@
    }
    # OEM encoding matches the codepage cmd.exe reads .cmd files in (handles
    # non-ASCII characters in the install path correctly).
    Set-Content -LiteralPath $launcher -Value $cmd -Encoding Oem

    # Persist the bin dir to the User PATH if it isn't already there.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $binDir) {
        $newUserPath = (@($userPath, $binDir) | Where-Object { $_ }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Ok "'brain' command installed (added $binDir to your user PATH)."
    } else {
        Write-Ok "'brain' command updated."
    }

    # Make 'brain' resolvable in the current session too.
    Update-SessionEnvironment

    return $launcher
}

# Create a Desktop shortcut that launches brain via the 'brain' launcher.
function Add-DesktopShortcut {
    param([string]$Launcher, [string]$AppDir)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktop 'brain.lnk'
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($lnkPath)
        $sc.TargetPath = $Launcher
        $sc.WorkingDirectory = $AppDir
        $sc.Description = 'Start brain'
        $icon = Join-Path $AppDir 'public\favicon.ico'
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon }
        $sc.Save()
        Write-Ok "Desktop shortcut created: $lnkPath"
    } catch {
        Write-Warn2 "Could not create desktop shortcut: $($_.Exception.Message)"
    }
}

# Record what this install did, so a future uninstaller can cleanly reverse it.
# Stored in the brain-cli bin dir (NOT inside $AppDir, which an uninstaller
# would delete) so it survives folder reinstalls.
function Write-InstallManifest {
    param(
        [string]$AppDir,
        [string]$InstallMode,
        [object[]]$Prereqs,
        [bool]$DesktopShortcut,
        [bool]$ExecutionPolicyChanged
    )
    try {
        $binDir = Join-Path $env:LOCALAPPDATA 'brain-cli'
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null

        $manifest = [PSCustomObject]@{
            schema                 = 1
            installDir             = $AppDir
            binDir                 = $binDir
            mode                   = $InstallMode
            branch                 = $Branch
            repoUrl                = $RepoUrl
            desktopShortcut        = $DesktopShortcut
            executionPolicyChanged = $ExecutionPolicyChanged
            prerequisites          = @($Prereqs | Where-Object { $_ } | ForEach-Object {
                [PSCustomObject]@{
                    command     = $_.Command
                    wingetId    = $_.WingetId
                    displayName = $_.DisplayName
                    preexisting = $_.Preexisting
                }
            })
        }

        $manifestPath = Join-Path $binDir 'install-manifest.json'
        Set-Content -LiteralPath $manifestPath -Value ($manifest | ConvertTo-Json -Depth 5) -Encoding UTF8
        Write-Ok "Install manifest written: $manifestPath"
    } catch {
        # Non-fatal: the install is fine without it.
        Write-Warn2 "Could not write install manifest: $($_.Exception.Message)"
    }
}

# --- Execution policy (standalone mode only) ---------------------------------

# Determine the execution policy that NEW terminals will actually get, i.e. the
# effective policy IGNORING this installer's transient Process-scope Bypass.
# Precedence (highest first) is MachinePolicy > UserPolicy > CurrentUser >
# LocalMachine; the first scope that isn't 'Undefined' wins. If all are
# Undefined, Windows falls back to 'Restricted'.
function Get-FutureExecutionPolicy {
    foreach ($scope in 'MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine') {
        $p = Get-ExecutionPolicy -Scope $scope
        if ($p -ne 'Undefined') { return $p }
    }
    return 'Restricted'
}

# Standalone mode runs npm (a .ps1 shim) both now and every time the 'brain'
# launcher starts, so a persistent policy is worthwhile there. We use the
# Microsoft-recommended 'RemoteSigned' at 'CurrentUser' scope, which needs no
# admin. Skipped if scripts are already allowed; asked for first (or driven by
# BRAIN_SET_POLICY). Docker mode never runs npm, so it skips this entirely.
function Set-PersistentExecutionPolicy {
    $current = Get-FutureExecutionPolicy
    if ($current -in @('RemoteSigned', 'Unrestricted', 'Bypass')) {
        Write-Ok "Execution policy already allows scripts in new terminals (effective = $current)."
        return $false
    }

    $consent = $false
    if ($env:BRAIN_SET_POLICY -in @('1', 'true', 'yes')) {
        $consent = $true
    } elseif ($env:BRAIN_SET_POLICY -in @('0', 'false', 'no')) {
        $consent = $false
    } else {
        Write-Warn2 "Windows blocks running PowerShell scripts (npm/npx are .ps1 shims) by default."
        Write-Warn2 "brain's standalone mode needs to run npm for this install and on every start."
        $ans = Read-Host "Set execution policy to RemoteSigned for your user account? (recommended) (Y/n)"
        $consent = -not ($ans -match '^\s*(n|no)\s*$')
    }

    if ($consent) {
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction Stop
            Write-Ok "Execution policy set to RemoteSigned (CurrentUser). Revert anytime with:"
            Write-Ok "    Set-ExecutionPolicy -ExecutionPolicy Restricted -Scope CurrentUser"
            return $true
        } catch {
            Write-Warn2 "Could not set execution policy: $($_.Exception.Message)"
            Write-Warn2 "This install will still proceed (policy is bypassed for this session)."
            Write-Warn2 "If npm fails in new terminals later, run this once in an admin PowerShell:"
            Write-Warn2 "    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine"
            return $false
        }
    } else {
        Write-Warn2 "Skipped. This install proceeds (session-only bypass), but npm may fail"
        Write-Warn2 "in new terminals later until you run:"
        Write-Warn2 "    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
        return $false
    }
}

Write-Host "brain Installer" -ForegroundColor Magenta
Write-Host "===============" -ForegroundColor Magenta

# winget is required to bootstrap the prerequisites.
if (-not (Test-Command 'winget')) {
    throw "winget (App Installer) was not found. Install 'App Installer' from the Microsoft Store, then re-run this script."
}

# ---------------------------------------------------------------------------
# 1. Gather all the user's choices up front, then run the install in one go.
#    Order: mode -> install path -> desktop shortcut -> start after ->
#    security policy (standalone only).
# ---------------------------------------------------------------------------
if ($Mode -notin @('docker', 'standalone')) {
    if (-not [string]::IsNullOrWhiteSpace($Mode)) {
        Write-Warn2 "Unknown mode '$Mode' (expected 'docker' or 'standalone')."
    }
    Write-Host ""
    Write-Host "How do you want to run brain?" -ForegroundColor Cyan
    Write-Host "  [1] docker      - the full experience: lobby, grow-a-brain, one isolated FLUJO per brain (needs Docker Desktop)"
    Write-Host "  [2] standalone  - one brain, no Docker (needs Node.js)"
    $modeAnswer = Read-Host "Pick a mode (press Enter for: 1)"
    $Mode = if ($modeAnswer -match '^\s*2\s*$') { 'standalone' } else { 'docker' }
}
Write-Ok "Mode: $Mode"

$defaultDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'brain' } else { Join-Path $HOME 'brain' }

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $answer = Read-Host "Where should brain be installed? (press Enter for: $defaultDir)"
    $InstallDir = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultDir } else { $answer.Trim() }
}
# Expand any environment variables the user may have typed (e.g. %USERPROFILE%).
$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
Write-Ok "Installing into: $InstallDir"

# Decide whether to create a Desktop shortcut (defaults to yes).
if ($env:BRAIN_SHORTCUT -in @('0', 'false', 'no')) {
    $makeShortcut = $false
} elseif ($env:BRAIN_SHORTCUT -in @('1', 'true', 'yes')) {
    $makeShortcut = $true
} else {
    $scAnswer = Read-Host "Create a desktop shortcut for brain? (Y/n)"
    $makeShortcut = -not ($scAnswer -match '^\s*(n|no)\s*$')
}

# Decide whether to start brain afterwards.
$startAfter = $Start.IsPresent
if (-not $startAfter) {
    if ($env:BRAIN_START -in @('1', 'true', 'yes')) {
        $startAfter = $true
    } elseif ($env:BRAIN_START -in @('0', 'false', 'no')) {
        $startAfter = $false
    } else {
        $startAnswer = Read-Host "Start brain when the install finishes? (Y/n)"
        $startAfter = -not ($startAnswer -match '^\s*(n|no)\s*$')
    }
}

# Last question (standalone only): persist the script-execution policy so npm
# works in future terminals. After this, the install runs without interruption.
$policyChanged = $false
if ($Mode -eq 'standalone') {
    $policyChanged = Set-PersistentExecutionPolicy
}

# ---------------------------------------------------------------------------
# 2. Install prerequisites via winget.
# ---------------------------------------------------------------------------
$prereqResults = @(
    Install-Prereq -CommandName 'git' -WingetId 'Git.Git' -DisplayName 'Git'
)

if ($Mode -eq 'docker') {
    $prereqResults += Install-Prereq -CommandName 'docker' -WingetId 'Docker.DockerDesktop' -DisplayName 'Docker Desktop'
    Update-SessionEnvironment

    if (-not (Test-Command 'docker')) {
        Write-Warn2 "Docker Desktop was installed but the 'docker' command is not on PATH yet."
        Write-Warn2 "A log-out (sometimes a reboot) is needed after a fresh Docker Desktop install."
        throw "Log out and back in (or reboot), start Docker Desktop once, then re-run this installer - it picks up where it left off."
    }

    # The CLI existing is not enough - the daemon must be running.
    if (-not (Test-DockerDaemon)) {
        Write-Step "Docker is installed but not running - starting Docker Desktop"
        if (Start-DockerDesktop) {
            Write-Warn2 "If this is Docker Desktop's first launch, accept its service agreement in the window that opened."
            Write-Ok "Waiting for the Docker engine (up to 3 minutes) ..."
            if (Wait-DockerDaemon) {
                Write-Ok "Docker engine is up."
            } else {
                throw "The Docker engine did not become ready. Finish Docker Desktop's setup (it may ask to enable WSL 2), then re-run this installer."
            }
        } else {
            throw "Could not find Docker Desktop.exe to start it. Start Docker Desktop yourself, then re-run this installer."
        }
    } else {
        Write-Ok "Docker engine is running."
    }
} else {
    # npm ships with Node.js, so there is no separate winget package for it.
    $prereqResults += Install-Prereq -CommandName 'node' -WingetId 'OpenJS.NodeJS' -DisplayName 'Node.js (includes npm)'
    Update-SessionEnvironment
    if (-not (Test-Command 'npm')) {
        throw "Node.js was installed but 'npm' is not on PATH yet. Open a new terminal and re-run this installer."
    }
}

# ---------------------------------------------------------------------------
# 3. Clone or update the repository.
# ---------------------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Step "Existing brain clone found - updating ($Branch)"
    # Hard-reset instead of pull: npm installs rewrite package-lock.json,
    # leaving the tree dirty, so `git pull` aborts with "local changes would be
    # overwritten by merge". This is an install/deploy copy, not a dev checkout,
    # so discarding tracked-file drift is safe; untracked node_modules/dist and
    # Docker volumes are unaffected.
    git -C $InstallDir fetch origin $Branch
    git -C $InstallDir checkout $Branch
    git -C $InstallDir reset --hard "origin/$Branch"
} else {
    Write-Step "Cloning brain into $InstallDir"
    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    git clone -b $Branch $RepoUrl $InstallDir
}

# ---------------------------------------------------------------------------
# 4. Prepare the install (build images / install dependencies).
# ---------------------------------------------------------------------------
Push-Location $InstallDir
try {
    if ($Mode -eq 'docker') {
        # Pull the prebuilt images. The FLUJO base feeds the local
        # flujo-browser build (FLUJO + headless Chromium for the "browser"
        # skill). Best effort: anything missing is built or pulled on first
        # `docker compose up`.
        Write-Step "Pulling prebuilt images (FLUJO, Ollama)"
        docker pull ghcr.io/mario-andreschak/flujo:latest
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 "Could not pull the FLUJO base image; the flujo build will fetch it itself."
        }
        docker compose pull ollama
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 "Could not pull the Ollama image; 'docker compose up' will."
        }

        Write-Step "Building the images (docker compose build brain flujo)"
        docker compose build brain flujo
        if ($LASTEXITCODE -ne 0) { throw "docker compose build failed." }
        Write-Ok "Images ready."
    } else {
        Write-Step "Installing npm dependencies (npm install)"
        # --include=dev: the vite/tsc build needs devDependencies, which npm
        # prunes when NODE_ENV=production.
        npm install --include=dev
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

        # Prefetch the manager's dependencies too; `npm run standalone` would do
        # it on first start, but doing it now makes that start much quicker.
        Write-Step "Installing manager dependencies (npm install --prefix manager)"
        npm install --prefix manager
        if ($LASTEXITCODE -ne 0) { throw "npm install --prefix manager failed." }
        Write-Ok "Dependencies installed."
    }

    # Register the global 'brain' command (works from any folder).
    $brainLauncher = Register-BrainCommand -AppDir $InstallDir -InstallMode $Mode
    if ($makeShortcut) {
        Add-DesktopShortcut -Launcher $brainLauncher -AppDir $InstallDir
    }

    # Record everything we did, so a future uninstaller can reverse it precisely.
    Write-InstallManifest -AppDir $InstallDir -InstallMode $Mode -Prereqs $prereqResults `
        -DesktopShortcut $makeShortcut -ExecutionPolicyChanged $policyChanged

    if ($startAfter) {
        if ($Mode -eq 'docker') {
            Write-Step "Starting brain (docker compose up -d)"
            docker compose up -d
            if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }
            Write-Ok "brain:        http://localhost:8080"
            Write-Ok "FLUJO editor: http://localhost:4200"
            Start-Process 'http://localhost:8080'
        } else {
            Write-Step "Starting brain (npm run standalone) - open http://localhost:8080"
            Start-Process 'http://localhost:8080'
            npm run standalone
        }
    } else {
        Write-Host "`nDone! Start brain from any folder by typing:" -ForegroundColor Green
        Write-Host "    brain" -ForegroundColor Green
        Write-Host "(in a new terminal). Then open http://localhost:8080" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
