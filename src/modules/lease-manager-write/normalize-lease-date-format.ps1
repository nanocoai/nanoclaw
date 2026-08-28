# One-time, purpose-built formatting normalization -- NOT part of the
# regular write-plan pipeline (apply-write-plan.ps1) and shares none of its
# code path. This script only ever changes NumberFormat on already-populated
# cells in the Write sheet's three lease-date columns (J/K/L). It never sets
# Value2, never touches any other column, never touches the Read sheet, and
# never adds/removes rows. A cell whose date value has already been
# normalized (e.g. by this script running twice) is simply set to the same
# format again -- idempotent, safe to re-run.
#
# Same safety shape as apply-write-plan.ps1: timestamped backup first,
# UpdateLinks:=0 on open (never touch the external-link cache), fresh
# independent reopen to verify the file still opens after.

param(
  [Parameter(Mandatory=$true)][string]$WorkbookPath,
  [Parameter(Mandatory=$true)][string]$BackupDir
)

$ErrorActionPreference = 'Stop'

$result = [ordered]@{
  ok = $false
  backupPath = $null
  cellsChanged = 0
  changedAddresses = @()
  reopenedOk = $false
  sheetNames = @()
  error = $null
}

try {
  # --- Timestamped backup before any write, unconditional ---
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMddTHHmmssZ'
  $backupName = [IO.Path]::GetFileNameWithoutExtension($WorkbookPath) + ".backup-$stamp" + [IO.Path]::GetExtension($WorkbookPath)
  $backupPath = Join-Path $BackupDir $backupName
  Copy-Item -Path $WorkbookPath -Destination $backupPath
  $result.backupPath = $backupPath

  $excel = $null
  $wb = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    # UpdateLinks:=0 -- never touch the external-link cache, never prompt.
    $wb = $excel.Workbooks.Open($WorkbookPath, 0, $false)

    $readSheet = $wb.Sheets.Item('Read')
    $writeSheet = $wb.Sheets.Item('Write')
    if (-not $readSheet) { throw "Read sheet not found -- aborting, no changes made." }
    if (-not $writeSheet) { throw "Write sheet not found -- aborting, no changes made." }

    $firstDataRow = 6
    $usedRange = $writeSheet.UsedRange
    $lastRow = $usedRange.Row + $usedRange.Rows.Count - 1
    $targetFormat = 'mm/dd/yyyy'

    $changed = 0
    $changedAddresses = @()
    foreach ($col in @(10, 11, 12)) {  # J=10 K=11 L=12
      for ($r = $firstDataRow; $r -le $lastRow; $r++) {
        $cell = $writeSheet.Cells.Item($r, $col)
        # Only touch cells that actually hold a value -- never write to a
        # blank cell, never change Value2, only ever NumberFormat.
        if ($null -ne $cell.Value2 -and $cell.Value2 -ne '') {
          if ($cell.NumberFormat -ne $targetFormat) {
            $cell.NumberFormat = $targetFormat
            $changed++
            $changedAddresses += $cell.Address($false, $false)
          }
        }
      }
    }

    $wb.Save()
    $sheetNames = @($wb.Sheets | ForEach-Object { $_.Name })

    $result.cellsChanged = $changed
    $result.changedAddresses = $changedAddresses
    $result.sheetNames = $sheetNames
  } finally {
    if ($wb) { $wb.Close($false); [Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
    if ($excel) { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }

  # --- Verify the workbook still opens -- fresh Excel instance, fresh handle ---
  $verifyExcel = $null; $verifyWb = $null
  try {
    $verifyExcel = New-Object -ComObject Excel.Application
    $verifyExcel.Visible = $false
    $verifyWb = $verifyExcel.Workbooks.Open($WorkbookPath, 0, $true)
    $reopenedSheets = @($verifyWb.Sheets | ForEach-Object { $_.Name })
    $result.reopenedOk = ($reopenedSheets -contains 'Read') -and ($reopenedSheets -contains 'Write')
  } finally {
    if ($verifyWb) { $verifyWb.Close($false); [Runtime.InteropServices.Marshal]::ReleaseComObject($verifyWb) | Out-Null }
    if ($verifyExcel) { $verifyExcel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($verifyExcel) | Out-Null }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }

  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

Write-Output "RESULT_JSON: $($result | ConvertTo-Json -Compress -Depth 5)"
