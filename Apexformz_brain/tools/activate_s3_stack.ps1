param([switch]$CreateApprovedRole)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$python = Join-Path $projectRoot 'data/audit/s3-service-venv/Scripts/python.exe'
$storage = Get-Content infrastructure/deployment/aws-storage.json -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls data/local-aws /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if (-not $storage.runtime_role) {
  if (-not $CreateApprovedRole) { throw 'The exact runtime IAM role must be approved before creation.' }
  & $python tools/runtime_credentials.py --create-role
} else {
  & $python tools/runtime_credentials.py
}
if ($LASTEXITCODE -ne 0) { throw 'Scoped runtime credentials were not provisioned' }
$envPath = Join-Path $projectRoot 'data/audit/operations/compose.env'
$lines = @(Get-Content -LiteralPath $envPath | Where-Object { $_ -notmatch '^(APEXFORMZ_S3_BUCKET|APEXFORMZ_AWS_ACCOUNT_ID|AWS_REGION)=' })
$lines += 'APEXFORMZ_S3_BUCKET=' + $storage.bucket
$lines += 'APEXFORMZ_AWS_ACCOUNT_ID=' + $storage.account_id
$lines += 'AWS_REGION=' + $storage.region
[IO.File]::WriteAllLines($envPath, $lines)
$helper = Start-Process -FilePath $python -ArgumentList @('tools/runtime_credentials.py', '--loop') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data/audit/operations/credential-refresh.log') -RedirectStandardError (Join-Path $projectRoot 'data/audit/operations/credential-refresh-error.log')
$helper.Id | Set-Content data/audit/operations/credential-refresh.pid
docker compose -p apexformz-ops -f infrastructure/deployment/docker-compose.yml --env-file $envPath --profile operations up -d --no-build
if ($LASTEXITCODE -ne 0) { throw 'Compose S3 activation failed; inspect health and credential refresh logs' }
