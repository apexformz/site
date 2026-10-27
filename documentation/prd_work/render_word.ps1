param(
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputDir,
    [switch]$UpdateAndSave
)

$ErrorActionPreference = 'Stop'
$inputFile = (Resolve-Path -LiteralPath $InputPath).Path
$outputFolder = [System.IO.Path]::GetFullPath($OutputDir)
[System.IO.Directory]::CreateDirectory($outputFolder) | Out-Null
$pdfFile = Join-Path $outputFolder ([System.IO.Path]::GetFileNameWithoutExtension($inputFile) + '.pdf')
$wordApp = $null
$wordDoc = $null
try {
    # New-Object creates a dedicated automation instance; no active object lookup.
    $wordApp = New-Object -ComObject Word.Application
    $wordApp.Visible = $false
    $wordApp.DisplayAlerts = 0
    $wordApp.AutomationSecurity = 3
    $wordApp.Options.SaveNormalPrompt = $false
    $wordDoc = $wordApp.Documents.Open($inputFile, $false, (-not $UpdateAndSave.IsPresent), $false)
    if ($UpdateAndSave.IsPresent) {
        $wordDoc.Fields.Update() | Out-Null
        foreach ($story in $wordDoc.StoryRanges) {
            $range = $story
            while ($null -ne $range) {
                $range.Fields.Update() | Out-Null
                $range = $range.NextStoryRange
            }
        }
        foreach ($toc in $wordDoc.TablesOfContents) { $toc.Update() }
        $wordDoc.Repaginate()
        foreach ($toc in $wordDoc.TablesOfContents) { $toc.UpdatePageNumbers() }
        $wordDoc.Save()
    }
    $wordDoc.Repaginate()
    $pageCount = $wordDoc.ComputeStatistics(2)
    $wordDoc.ExportAsFixedFormat($pdfFile, 17)
    [pscustomobject]@{input=$inputFile; pdf=$pdfFile; pages=$pageCount; saved=$UpdateAndSave.IsPresent} | ConvertTo-Json -Compress
}
finally {
    if ($null -ne $wordDoc) {
        $wordDoc.Close(0)
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($wordDoc) | Out-Null
    }
    if ($null -ne $wordApp) {
        $wordApp.Quit(0)
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($wordApp) | Out-Null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
