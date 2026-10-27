$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $desktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (!(Test-Path -LiteralPath $desktop)) { throw 'Install and start Docker Desktop, then retry npm run demo.' }
    Start-Process -FilePath $desktop -WindowStyle Hidden
    Write-Host 'Waiting for Docker Desktop...'
    $deadline = (Get-Date).AddMinutes(2)
    do {
        Start-Sleep -Seconds 2
        docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        if ((Get-Date) -gt $deadline) { throw 'Docker engine did not start. Restart Docker Desktop and retry npm run demo.' }
    } while ($true)
}
docker start smartcoach-db | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Existing smartcoach-db container was not found. Follow BRAIN_INTEGRATION.md database setup.' }
$deadline = (Get-Date).AddSeconds(60)
do {
    docker exec smartcoach-db pg_isready -U smartcoach -d smartcoach | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw 'Database did not become ready. Check docker logs smartcoach-db.' }
    Start-Sleep -Seconds 2
} while ($true)
Write-Host 'Database ready. Starting the Brain API and web interface. Wait for both servers before registering.'
npm.cmd run dev
exit $LASTEXITCODE
