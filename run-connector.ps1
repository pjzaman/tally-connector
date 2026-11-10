$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
# Read node's output as UTF-8 so Bengali names and symbols reach the log intact.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$env:VOUCHER_PERIOD_FROM = "2026-01-01"
$env:ENABLE_DATA_SYNC = "true"
$env:ENABLE_DELETION_SWEEPS = "true"
$env:ENABLE_QUERY_QUEUE = "true"
$env:TALLY_TIMEOUT_MS = "120000"

$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory "connector.log"
$oldLogPath = Join-Path $logDirectory "connector.previous.log"
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
    Move-Item -LiteralPath $logPath -Destination $oldLogPath -Force
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
function Write-ConnectorLogLine([string]$line) {
    [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $utf8NoBom)
}

while ($true) {
    Write-ConnectorLogLine "$(Get-Date -Format o) Starting Tally connector."
    $nodeArgs = @()
    if (Test-Path -LiteralPath (Join-Path $projectRoot ".env")) { $nodeArgs += "--env-file=.env" }
    $nodeArgs += "src/main.js"
    # Open and close the log for each line so the owner can read it while the connector runs.
    & $nodePath @nodeArgs 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        Write-ConnectorLogLine "$(Get-Date -Format o) $line"
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { break }
    Write-ConnectorLogLine "$(Get-Date -Format o) Connector exited with code $exitCode; retrying in 30 seconds."
    Start-Sleep -Seconds 30
}
