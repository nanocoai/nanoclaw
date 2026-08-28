# Mechanical apply step only -- no matching/cleaning/escalation logic lives
# here. The plan it's given is already fully resolved and approved; this
# script's only job is to place those exact values into the Write sheet
# without disturbing anything else in the workbook.
#
# Tested against a disposable copy before ever being pointed at a live
# workbook: backup integrity, row placement (fixed a real UsedRange-vs-actual-
# data bug), Read-sheet formula/value preservation, external-link byte
# identity, styles/metadata preservation, and a clean independent reopen were
# all verified there first.

param(
  [Parameter(Mandatory=$true)][string]$WorkbookPath,
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [Parameter(Mandatory=$true)][string]$BackupDir
)

$ErrorActionPreference = 'Stop'

# Three-state cell setter: property absent on the row -> leave the cell
# untouched entirely; property present but null -> explicitly clear it;
# property present with a value -> set it. $IsDate parses "yyyy-MM-dd"
# deterministically (InvariantCulture, ParseExact -- never locale-dependent
# Parse) and writes a real Excel date value, not inert text.
function Set-CellFromThreeState {
  param($Sheet, $Row, [int]$Col, $PSObj, [string]$PropName, [bool]$IsDate = $false)
  $prop = $PSObj.PSObject.Properties.Match($PropName)
  if ($prop.Count -eq 0) { return } # absent: untouched
  $val = $prop[0].Value
  $cell = $Sheet.Cells.Item($Row, $Col)
  if ($null -eq $val) {
    $cell.ClearContents() # explicit null: clear
    return
  }
  if ($IsDate) {
    $cell.Value2 = [datetime]::ParseExact([string]$val, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
    # Display format only -- Value2 above is still a real Excel date serial,
    # this just changes how it renders (mm/dd/yyyy, e.g. 08/14/2026). Applies
    # to LeaseStartDate/LeaseEndDate/LeaseReminderDate, the only three
    # date-typed columns this function ever writes.
    $cell.NumberFormat = 'mm/dd/yyyy'
  } else {
    $cell.Value2 = [string]$val
  }
}
$result = [ordered]@{
  ok = $false
  backupPath = $null
  written = 0
  appended = 0
  updated = 0
  skipped = 0
  skippedDetails = @()
  reopenedOk = $false
  sheetNames = @()
  error = $null
}

try {
  # --- 1. Timestamped backup before any write, unconditional ---
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMddTHHmmssZ'
  $backupName = [IO.Path]::GetFileNameWithoutExtension($WorkbookPath) + ".backup-$stamp" + [IO.Path]::GetExtension($WorkbookPath)
  $backupPath = Join-Path $BackupDir $backupName
  Copy-Item -Path $WorkbookPath -Destination $backupPath
  $result.backupPath = $backupPath

  # --- Prune backups beyond the retention count, oldest first ---
  $existing = Get-ChildItem -Path $BackupDir -Filter '*.backup-*' | Sort-Object LastWriteTime -Descending
  if ($existing.Count -gt 10) {
    $existing | Select-Object -Skip 10 | ForEach-Object { Remove-Item $_.FullName -Force }
  }

  $plan = Get-Content -Path $PlanPath -Raw | ConvertFrom-Json

  $excel = $null
  $wb = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    # UpdateLinks:=0 -- never touch the external-link cache, never prompt,
    # never let a link refresh mutate Read-sheet formula results as a side
    # effect of opening the file for this write.
    $wb = $excel.Workbooks.Open($WorkbookPath, 0, $false)

    $readSheet = $wb.Sheets.Item('Read')
    $writeSheet = $wb.Sheets.Item('Write')

    # --- 2. Never touch the Read sheet: don't even select it ---
    if (-not $readSheet) { throw "Read sheet not found -- aborting, no changes made." }
    if (-not $writeSheet) { throw "Write sheet not found -- aborting, no changes made." }

    # Ensure the Lease Status header exists -- pure addition in the first
    # unused column (M), idempotent, never touches D:L.
    $writeSheet.Cells.Item(5, 13).Value2 = 'Lease Status'

    # Write-sheet layout: header row 5, data starts row 6, columns D:M
    #   D=Name E=Address F=Rent G=Deposit H=Market I=RenewalRent
    #   J=LeaseStart K=LeaseEnd L=LeaseReminder M=LeaseStatus
    $firstDataRow = 6
    $usedRange = $writeSheet.UsedRange
    $lastRow = $usedRange.Row + $usedRange.Rows.Count - 1

    # --- 4. Address is the primary key; tenant name is confirmation only ---
    # UsedRange.Rows.Count reflects Excel's own bookkeeping, which can include
    # rows that were only ever formatted, never populated -- on a pristine
    # sheet this over-reports how far real data goes. Track the true last
    # populated row (by actual address values found) separately, and scan a
    # generous margin past UsedRange in case it under-reports instead.
    $scanLastRow = [Math]::Max($lastRow, $firstDataRow) + 20
    $addressToRow = @{}
    $lastDataRow = $firstDataRow - 1
    for ($r = $firstDataRow; $r -le $scanLastRow; $r++) {
      $addr = $writeSheet.Cells.Item($r, 5).Value2
      if ($addr) {
        $addressToRow[$addr] = $r
        $lastDataRow = $r
      }
    }

    $nextFreeRow = $lastDataRow + 1
    $written = 0; $appended = 0; $updated = 0; $skipped = 0
    $skippedDetails = @()

    foreach ($row in $plan) {
      if (-not $row.Address) {
        $skipped++
        $skippedDetails += "missing address (name: '$($row.Name)')"
        continue  # --- 5. never write an unresolved/keyless row ---
      }

      $isUpdate = $false
      if ($addressToRow.ContainsKey($row.Address)) {
        $targetRow = $addressToRow[$row.Address]
        $isUpdate = $true
        $existingName = $writeSheet.Cells.Item($targetRow, 4).Value2
        if ($existingName -and $row.Name -and $existingName -ne $row.Name -and $row.Status -ne 'Vacant') {
          # Name mismatch at a matched address -- exactly the case that must
          # escalate, not overwrite. The apply step refuses silently; the
          # upstream matching step should never produce such a row, but this
          # is the mechanical backstop.
          $skipped++
          $skippedDetails += "name mismatch at $($row.Address): sheet has '$existingName', plan has '$($row.Name)'"
          continue
        }
      } else {
        $targetRow = $nextFreeRow
        $nextFreeRow++
      }

      $writeSheet.Cells.Item($targetRow, 4).Value2 = [string]$row.Name
      $writeSheet.Cells.Item($targetRow, 5).Value2 = [string]$row.Address
      if ($null -ne $row.Rent)    { $writeSheet.Cells.Item($targetRow, 6).Value2 = [double]$row.Rent }
      if ($null -ne $row.Deposit) { $writeSheet.Cells.Item($targetRow, 7).Value2 = [double]$row.Deposit }
      if ($null -ne $row.Market)  { $writeSheet.Cells.Item($targetRow, 8).Value2 = [double]$row.Market }
      # --- 3. Renewal Rent (I) is never written -- no source for it in this
      # path. Lease Start/End/Reminder (J/K/L) and Lease Status (M) are
      # three-state: absent = untouched, null = cleared, value = set. The
      # resolved plan from request.ts already encodes exactly that.
      Set-CellFromThreeState -Sheet $writeSheet -Row $targetRow -Col 10 -PSObj $row -PropName 'LeaseStartDate' -IsDate $true
      Set-CellFromThreeState -Sheet $writeSheet -Row $targetRow -Col 11 -PSObj $row -PropName 'LeaseEndDate' -IsDate $true
      Set-CellFromThreeState -Sheet $writeSheet -Row $targetRow -Col 12 -PSObj $row -PropName 'LeaseReminderDate' -IsDate $true
      Set-CellFromThreeState -Sheet $writeSheet -Row $targetRow -Col 13 -PSObj $row -PropName 'LeaseStatus'
      $written++
      if ($isUpdate) { $updated++ } else { $appended++ }
    }

    $wb.Save()
    $sheetNames = @($wb.Sheets | ForEach-Object { $_.Name })

    $result.written = $written
    $result.appended = $appended
    $result.updated = $updated
    $result.skipped = $skipped
    $result.skippedDetails = $skippedDetails
    $result.sheetNames = $sheetNames
  } finally {
    if ($wb) { $wb.Close($false); [Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
    if ($excel) { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }

  # --- 6. Verify the workbook still opens -- a completely fresh Excel
  # instance and a fresh file handle, not the one still in memory above. ---
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
