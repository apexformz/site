param(
    [switch]$NoBrowser,
    [switch]$WithLegacyAI,
    [ValidateRange(1, 65535)][int]$WebPort = 3000,
    [ValidateRange(1, 65535)][int]$ApiPort = 4000
)

$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$startedProcesses = @()
$logFolder = Join-Path ([IO.Path]::GetTempPath()) 'ApexFormz\launcher-logs'
$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID

function Test-ApiReady {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3
        $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/ready" -TimeoutSec 3
        return ($health.success -eq $true -and $health.message -eq 'SmartCoach Backend is running' -and $ready.database -eq 'ready')
    } catch { return $false }
}

function Test-WebReady {
    try {
        $homeResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 10
        $manifest = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/brain/sport-packs/squash/manifest" -TimeoutSec 5
        return ($homeResponse.StatusCode -eq 200 -and $manifest.id -eq 'squash')
    } catch { return $false }
}

function Test-SportsAnalysisReady {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3
        return ($health.status -eq 'healthy' -and $health.service -eq 'SmartCoach AI')
    } catch { return $false }
}

function Test-Listening([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-ServiceProcess([string]$Command, [string]$Name) {
    New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
    $stdout = Join-Path $logFolder "$runId-$Name.out.log"
    $stderr = Join-Path $logFolder "$runId-$Name.err.log"
    $child = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $Command) `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
    $script:startedProcesses += $child
    Write-Host "Started $Name launcher (PID $($child.Id)); logs: $logFolder"
    return $child
}

function Find-SportsPython {
    $brainRoot = if ($env:APEXFORMZ_BRAIN_DIR) {
        $env:APEXFORMZ_BRAIN_DIR
    } elseif (Test-Path -LiteralPath (Join-Path $projectRoot 'Apexformz_brain\package.json')) {
        Join-Path $projectRoot 'Apexformz_brain'
    } else {
        Join-Path (Split-Path $projectRoot -Parent) 'Apexformz_brain'
    }
    $aiRoot = Join-Path $projectRoot 'apps\ai-service'
    $candidates = @(
        (Join-Path $aiRoot '.venv\Scripts\python.exe'),
        (Join-Path $brainRoot '.venv\Scripts\python.exe')
    )
    foreach ($candidate in $candidates) {
        if (!(Test-Path -LiteralPath $candidate)) { continue }
        Push-Location -LiteralPath $aiRoot
        try {
            & $candidate -c 'import uvicorn, main, app.services.dynamic.movement_registry' 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } finally { Pop-Location }
    }
    return $null
}

function Start-SportsPython([string]$PythonPath) {
    New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
    $stdout = Join-Path $logFolder "$runId-sports-analysis.out.log"
    $stderr = Join-Path $logFolder "$runId-sports-analysis.err.log"
    $child = Start-Process -FilePath $PythonPath `
        -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000') `
        -WorkingDirectory (Join-Path $projectRoot 'apps\ai-service') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
    $script:startedProcesses += $child
    Write-Host "Started sports analysis (PID $($child.Id)); logs: $logFolder"
    return $child
}

function Wait-ForService([scriptblock]$Check, $Child, [string]$Name, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Check) { return }
        if ($Child.HasExited) { throw "$Name stopped while starting. See logs in $logFolder." }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not become ready within $TimeoutSeconds seconds. See logs in $logFolder."
}

$appAvailable = $false
try {
    if ($WebPort -eq $ApiPort) { throw 'The interface and API ports must be different.' }
    if (!(Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is required for the local database.' }
    if (!(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js and npm are required to start ApexFormz.' }
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'apps\backend\.env'))) {
        throw 'Configure apps/backend/.env before starting. See BRAIN_INTEGRATION.md.'
    }

    Write-Host '[1/5] Checking Docker and the existing PostgreSQL database...'
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (!(Test-Path -LiteralPath $desktop)) { throw 'Install and start Docker Desktop, then retry.' }
        Start-Process -FilePath $desktop -WindowStyle Hidden
        Write-Host 'Waiting for Docker Desktop...'
        $deadline = (Get-Date).AddMinutes(2)
        do {
            Start-Sleep -Seconds 2
            docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
        } while ((Get-Date) -lt $deadline)
        if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop did not become ready. Start it and try again.' }
    }

    $dbRunning = docker inspect --format '{{.State.Running}}' smartcoach-db 2>$null
    if ($LASTEXITCODE -ne 0) {
        docker compose up -d postgres
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the PostgreSQL container.' }
    } elseif ($dbRunning -ne 'true') {
        docker start smartcoach-db | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the existing smartcoach-db container.' }
    }
    $deadline = (Get-Date).AddSeconds(60)
    do {
        docker exec smartcoach-db pg_isready -U smartcoach -d smartcoach 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready. Check Docker Desktop.' }

    Write-Host '[2/5] Checking database schema...'
    & npm.cmd run db:prepare
    if ($LASTEXITCODE -ne 0) { throw 'Database setup failed. Review the message above.' }

    # The local demo uses development-signed packs.
    $env:NODE_ENV = 'development'
    $env:PORT = "$ApiPort"
    $env:HOST = '127.0.0.1'
    $env:CORS_ORIGIN = "http://localhost:$WebPort"
    $env:APEXFORMZ_API_ORIGIN = "http://127.0.0.1:$ApiPort"
    $env:NEXT_PUBLIC_SOCKET_URL = "http://127.0.0.1:$ApiPort"
    $env:APEXFORMZ_PACK_TRUST_MODE = 'development'
    $env:NEXT_PUBLIC_PACK_TRUST_MODE = 'development'

    Write-Host '[3/5] Starting sports analysis for the other disciplines...'
    $sportsProcess = $null
    $sportsUsesDocker = $false
    $sportsFailure = $null
    if (Test-SportsAnalysisReady) {
        Write-Host 'Using the healthy sports analysis service already running on port 8000.'
    } elseif (Test-Listening 8000) {
        $sportsFailure = 'Port 8000 is occupied by another or unhealthy service. Stop it and retry.'
    } else {
        try {
            $sportsPython = Find-SportsPython
            if ($sportsPython) {
                $sportsProcess = Start-SportsPython $sportsPython
            } else {
                Write-Host 'Preparing the sports analysis Docker image in the background. The app will open while it builds.'
                $sportsUsesDocker = $true
                $sportsProcess = Start-ServiceProcess 'docker compose up -d --build ai-service' 'sports-analysis-build'
            }
        } catch { $sportsFailure = $_.Exception.Message }
    }

    Write-Host '[4/5] Starting the Brain API...'
    if (Test-ApiReady) {
        Write-Host "Using the healthy ApexFormz API already running on port $ApiPort."
    } else {
        if (Test-Listening $ApiPort) { throw "Port $ApiPort is occupied by another or unhealthy service. Stop it and retry." }
        $api = Start-ServiceProcess 'npm.cmd run dev:backend' 'backend'
        Wait-ForService ${function:Test-ApiReady} $api 'Brain API' 90
    }

    Write-Host '[5/5] Starting the full interface...'
    if (Test-WebReady) {
        Write-Host "Using the healthy ApexFormz interface already running on port $WebPort."
    } else {
        if (Test-Listening $WebPort) { throw "Port $WebPort is occupied by another or unhealthy service. Stop it and retry." }
        $web = Start-ServiceProcess "npm.cmd run dev:frontend -- --port $WebPort" 'frontend'
        Wait-ForService ${function:Test-WebReady} $web 'Interface' 150
    }

    $address = "http://localhost:$WebPort/"
    $appAvailable = $true
    Write-Host "ApexFormz interface is ready: $address"
    if (!$NoBrowser) { Start-Process -FilePath $address }

    if ($sportsFailure) { throw "The interface is open, but sports analysis could not start: $sportsFailure" }
    if (!(Test-SportsAnalysisReady)) {
        Write-Host 'Waiting for sports analysis. The app is available while this finishes.'
        $deadline = (Get-Date).AddMinutes(10)
        $nextProgress = (Get-Date).AddSeconds(30)
        do {
            if (Test-SportsAnalysisReady) { break }
            if ($sportsProcess -and $sportsProcess.HasExited -and (!$sportsUsesDocker -or $sportsProcess.ExitCode -ne 0)) {
                throw "Sports analysis stopped while starting. See logs in $logFolder."
            }
            if ((Get-Date) -ge $nextProgress) {
                Write-Host "Sports analysis is still starting. Details: $logFolder"
                $nextProgress = (Get-Date).AddSeconds(30)
            }
            Start-Sleep -Seconds 2
        } while ((Get-Date) -lt $deadline)
        if (!(Test-SportsAnalysisReady)) { throw "Sports analysis is still unavailable. See logs in $logFolder." }
    }
    Write-Host 'Brain API, interface, database, and sports analysis are ready.'
    exit 0
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    if (!$appAvailable) {
        foreach ($child in $startedProcesses) {
            if (!$child.HasExited) { & taskkill.exe /PID $child.Id /T /F 2>$null | Out-Null }
        }
    }
    exit 1
}
