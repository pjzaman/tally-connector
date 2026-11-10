$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

# Leave both blank so verify-exports checks every company returned by Tally.
$env:COMPANY_GUID = ""
$env:COMPANY_NAME = ""

Write-Output "Listing companies currently loaded in TallyPrime..."
npm run verify-tally
if ($LASTEXITCODE -ne 0) { throw "Company listing failed. The scheduled connector was not changed." }

Write-Output "Running bounded, read-only exports for every loaded company..."
npm run verify-exports
if ($LASTEXITCODE -ne 0) { throw "A bounded Tally export check failed. The scheduled connector was not changed." }

Write-Output "Checks passed. Switching the scheduled connector to the updated multi-company runner..."
Stop-ScheduledTask -TaskName "Tally Firestore Connector"
$deadline = (Get-Date).AddSeconds(60)
while ((Get-ScheduledTask -TaskName "Tally Firestore Connector").State -ne "Ready") {
    if ((Get-Date) -ge $deadline) { throw "The scheduled task did not stop within 60 seconds. It has not been reinstalled or restarted." }
    Start-Sleep -Seconds 1
}

$installScript = Join-Path $projectRoot "install-autostart.ps1"
$powershellPath = Join-Path $PSHOME "powershell.exe"
& $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installScript
if ($LASTEXITCODE -ne 0) { throw "Task registration failed. Start it manually after reviewing the error." }

Start-ScheduledTask -TaskName "Tally Firestore Connector"
Start-Sleep -Seconds 5
$task = Get-ScheduledTask -TaskName "Tally Firestore Connector"
Write-Output "Scheduled task state: $($task.State)"
$task.Actions | Format-List Execute, Arguments, WorkingDirectory
Get-Content (Join-Path $projectRoot "logs\connector.log") -Tail 40
