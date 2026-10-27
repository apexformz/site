param(
    [string]$Profile = 'apexformz-owner',
    [ValidateRange(1, 8)][int]$Workers = 4,
    [ValidateRange(1, 100000)][int]$Steps = 1000,
    [ValidateSet('auto', 'cpu', 'cuda')][string]$Device = 'auto',
    [ValidateSet('encoded', 'metadata')][string]$OrientationPolicy = 'encoded',
    [string]$OrientationOverrides = 'data/squash/orientation_overrides_v1.json',
    [switch]$AllowPartialCoverage,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonExecutable = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    $pythonExecutable = (Get-Command python -ErrorAction Stop).Source
}
$env:AWS_SDK_UA_APP_ID = 'AWSSkill-SageMaker'
$env:OMP_NUM_THREADS = '1'
$env:MKL_NUM_THREADS = '1'
$runDirectory = Join-Path $projectRoot ('ml/runs/squash/' + (Get-Date -Format 'yyyyMMddTHHmmss'))

# Source is deliberately fixed to the squash Data Capture collection.
& $pythonExecutable -u -m ml.ingestion.capture --profile $Profile --region ap-southeast-2 `
    --bucket apexformz-datacapture-prod-350445709199-ap-southeast-2-media `
    --prefix raw/squash/ --sport squash `
    --manifest-bucket apexformz-datacapture-prod-350445709199-ap-southeast-2-labels `
    --out data/squash/capture_inventory.json --cache-dir data/squash/media --workers $Workers
if ($LASTEXITCODE -ne 0) { throw 'Squash S3 import failed. Check the named AWS session and the reported error.' }

$prepareArguments = @('-u', 'tools/prepare_capture_dataset.py', '--inventory', 'data/squash/capture_inventory.json',
    '--out-dir', 'data/squash', '--variant', 'full', '--sample-hz', '30', '--workers', "$Workers", '--orientation-policy', $OrientationPolicy)
# Apply only the exact source-ID/SHA-bound visual audit, never a guessed rotation.
if ($OrientationOverrides -and (Test-Path -LiteralPath $OrientationOverrides)) {
    $prepareArguments += @('--orientation-overrides', (Resolve-Path -LiteralPath $OrientationOverrides).Path)
} elseif ($PSBoundParameters.ContainsKey('OrientationOverrides') -and $OrientationOverrides) {
    throw 'The explicitly requested orientation audit does not exist.'
}
& $pythonExecutable @prepareArguments
if ($LASTEXITCODE -ne 0) { throw 'Squash pose preparation failed; no new model was installed.' }

& $pythonExecutable -u tools/capture_preparation_coverage.py --inventory data/squash/capture_inventory.json --out-dir data/squash
if ($LASTEXITCODE -ne 0) { throw 'Squash source-label coverage verification failed.' }

$trainingArguments = @('tools/train_squash_models.py', '--data-dir', 'data/squash', '--runs-dir', $runDirectory, '--device', $Device, '--steps', "$Steps")
if ($PrepareOnly) { $trainingArguments += '--plan-only' }
if ($AllowPartialCoverage) { $trainingArguments += '--allow-partial-coverage' }
& $pythonExecutable -u @trainingArguments
if ($LASTEXITCODE -ne 0) { throw 'Squash training/evaluation failed. Inspect the run directory before retrying.' }
Write-Host "Squash run evidence: $runDirectory"
