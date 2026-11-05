$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
# Read node's output as UTF-8 so Bengali names and symbols reach the log intact.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$env:COMPANY_NAME = "Apon Enterprise"
$env:COMPANY_GUID = "09b375e0-4ed2-439a-9a57-e843522ffa76"
$env:ENABLE_DATA_SYNC = "true"
$env:ENABLE_DELETION_SWEEPS = "false"
$env:ENABLE_QUERY_QUEUE = "true"

$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory "connector.log"
$oldLogPath = Join-Path $logDirectory "connector.previous.log"
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
    Move-Item -LiteralPath $logPath -Destination $oldLogPath -Force
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
while ($true) {
    "$(Get-Date -Format o) Starting Tally connector." | Add-Content -LiteralPath $logPath -Encoding UTF8
    $nodeArgs = @()
    if (Test-Path -LiteralPath (Join-Path $projectRoot ".env")) { $nodeArgs += "--env-file=.env" }
    $nodeArgs += "src/main.js"
    # Pipe node's output through PowerShell so every line is written as UTF-8 with a timestamp.
    # (Redirecting with *>> mixed UTF-16 into the UTF-8 log and logged stderr as PowerShell errors.)
    & $nodePath @nodeArgs 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        "$(Get-Date -Format o) $line"
    } | Add-Content -LiteralPath $logPath -Encoding UTF8
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { break }
    "$(Get-Date -Format o) Connector exited with code $exitCode; retrying in 30 seconds." | Add-Content -LiteralPath $logPath -Encoding UTF8
    Start-Sleep -Seconds 30
}
