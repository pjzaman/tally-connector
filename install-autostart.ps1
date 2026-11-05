$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $projectRoot "run-connector.ps1"
if (-not (Test-Path -LiteralPath $runnerPath)) { throw "Connector runner not found: $runnerPath" }

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellPath = Join-Path $PSHOME "powershell.exe"
$quotedRunner = '"' + $runnerPath + '"'
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedRunner"
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName "Tally Firestore Connector" `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Runs the read-only Tally connector for the Apon Enterprise mirror after this Windows user signs in." `
    -Force | Out-Null

Write-Output "Installed. The connector will start hidden at your next Windows sign-in, under the same account that holds the APE_TALLY_CONNECTOR_KEY credential."
Write-Output "To start it now, run: Start-ScheduledTask -TaskName 'Tally Firestore Connector'"
Write-Output "To stop it, run: Stop-ScheduledTask -TaskName 'Tally Firestore Connector'"
