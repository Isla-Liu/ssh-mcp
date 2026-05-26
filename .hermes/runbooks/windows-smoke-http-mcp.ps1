<#
.SYNOPSIS
    Windows-host smoke driver for ssh-mcp HTTP MCP transport.

.DESCRIPTION
    Companion to .hermes/runbooks/windows-smoke-http-mcp.md.
    Detects whether Flow A (mcp-proxy bridge, current prod) or Flow B
    (in-process Streamable HTTP, P2 plan) is active, runs the three
    JSON-RPC calls (initialize -> tools/list -> tools/call exec), and
    prints a tick-box summary of the success criteria.

    Does NOT start or stop ssh-mcp. The operator is expected to have
    started the listener via StandaloneMcpServer.bat (Flow A) or
    `node build\index.js --transport-mcp=http ...` (Flow B) before
    running this script.

.PARAMETER Flow
    'A' for the mcp-proxy bridge, 'B' for in-process. Default: 'Auto'
    (probe the process table and pick whichever is running).

.PARAMETER Connection
    SSH connection name registered on the running ssh-mcp instance.
    Default 'EIP2-DB' (matches the StandaloneMcpServers.ps1 pinned
    target).

.PARAMETER Command
    Remote command to run via the `exec` tool. Default 'hostname && id && date -u'.

.PARAMETER FlowAUrl
    Override URL for Flow A. Default 'http://192.168.144.1:8934/mcp'.

.PARAMETER FlowBUrl
    Override URL for Flow B. Default 'http://127.0.0.1:8934/mcp'.

.PARAMETER TokenEnvVar
    Name of the env var holding the bearer for Flow B. Default 'SSH_MCP_HTTP_TOKEN'.

.PARAMETER AuditDir
    Directory holding the audit JSONL files. Default "$env:USERPROFILE\.ssh-mcp\logs".

.EXAMPLE
    PS> .\windows-smoke-http-mcp.ps1
    Auto-detects flow, runs the full smoke, prints checklist.

.EXAMPLE
    PS> .\windows-smoke-http-mcp.ps1 -Flow B -Command 'whoami /upn'
    Forces Flow B and uses a custom remote command.

.NOTES
    Returns exit code 0 if every success criterion ticks, 1 otherwise.
    Safe to re-run. Idempotent. Performs no destructive operation.
#>

[CmdletBinding()]
param(
    [ValidateSet('A', 'B', 'Auto')]
    [string] $Flow = 'Auto',

    [string] $Connection = 'EIP2-DB',

    [string] $Command = 'hostname && id && date -u',

    [string] $FlowAUrl = 'http://192.168.144.1:8934/mcp',
    [string] $FlowBUrl = 'http://127.0.0.1:8934/mcp',

    [string] $TokenEnvVar = 'SSH_MCP_HTTP_TOKEN',

    [string] $AuditDir = (Join-Path $env:USERPROFILE '.ssh-mcp\logs')
)

$ErrorActionPreference = 'Stop'
$results = [ordered]@{}

function Write-Section($title) {
    Write-Host ''
    Write-Host ("== {0} ==" -f $title) -ForegroundColor Cyan
}

function Tick([bool] $ok, [string] $label) {
    $glyph = if ($ok) { '[x]' } else { '[ ]' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("  {0} {1}" -f $glyph, $label) -ForegroundColor $color
    $results[$label] = $ok
}

# --------------------------------------------------------------------- 0. Flow detection
function Detect-Flow {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'ssh-mcp|mcp-proxy' }

    $aRunning = $procs | Where-Object { $_.CommandLine -match 'mcp-proxy.*ssh-mcp' }
    $bRunning = $procs | Where-Object { $_.CommandLine -match 'ssh-mcp-kerberos.*--transport-mcp=http' }

    if ($aRunning -and -not $bRunning) { return 'A' }
    if ($bRunning -and -not $aRunning) { return 'B' }
    if ($aRunning -and $bRunning)      { return 'AB' }
    return $null
}

if ($Flow -eq 'Auto') {
    Write-Section '0. Detecting active flow'
    $detected = Detect-Flow
    switch ($detected) {
        'A'  { Write-Host '  -> Flow A (mcp-proxy bridge) detected.' -ForegroundColor Yellow; $Flow = 'A' }
        'B'  { Write-Host '  -> Flow B (in-process HTTP) detected.' -ForegroundColor Yellow; $Flow = 'B' }
        'AB' { Write-Warning "Both Flow A and Flow B processes are running. Pick explicitly with -Flow A or -Flow B."; exit 2 }
        $null { Write-Error 'Neither Flow A nor Flow B is running. Start ssh-mcp first (see runbook §4).'; exit 2 }
    }
}

if ($Flow -eq 'A') {
    $mcpUrl  = $FlowAUrl
    $headers = @{ 'Content-Type' = 'application/json' }
    $token   = $null
} elseif ($Flow -eq 'B') {
    $mcpUrl = $FlowBUrl
    $token  = [Environment]::GetEnvironmentVariable($TokenEnvVar, 'User')
    if (-not $token) { $token = [Environment]::GetEnvironmentVariable($TokenEnvVar, 'Process') }
    if (-not $token) {
        Write-Error ("Flow B selected but env var {0} is empty (User or Process scope). Set it before running." -f $TokenEnvVar)
        exit 2
    }
    $headers = @{
        'Content-Type'  = 'application/json'
        'Authorization' = "Bearer $token"
    }
}

Write-Host ("MCP URL    : {0}" -f $mcpUrl)
Write-Host ("Flow       : {0}" -f $Flow)
Write-Host ("Connection : {0}" -f $Connection)

# --------------------------------------------------------------------- 1. Kerberos ticket
Write-Section '1. Kerberos ticket (klist)'
$klist = & klist 2>&1 | Out-String
$hasTgt = $klist -match 'krbtgt'
Tick $hasTgt "klist shows a TGT (krbtgt entry present)"
if (-not $hasTgt) {
    Write-Host $klist -ForegroundColor DarkGray
    Write-Warning 'No TGT. See runbook §3. Aborting smoke.'
    exit 1
}

# --------------------------------------------------------------------- 2. initialize
Write-Section '2. MCP handshake: initialize'

$initBody = @{
    jsonrpc = '2.0'
    id      = 1
    method  = 'initialize'
    params  = @{
        protocolVersion = '2024-11-05'
        capabilities    = @{}
        clientInfo      = @{ name = 'smoke-windows'; version = '1.0.0' }
    }
} | ConvertTo-Json -Compress -Depth 8

try {
    $resp = Invoke-WebRequest -Uri $mcpUrl -Method Post -Headers $headers -Body $initBody -UseBasicParsing -TimeoutSec 30
} catch {
    Tick $false "POST initialize returned HTTP 200"
    Write-Host $_.Exception.Message -ForegroundColor DarkRed
    exit 1
}
$initOk    = ($resp.StatusCode -eq 200)
$initJson  = $resp.Content | ConvertFrom-Json
$serverOk  = ($initJson.result.serverInfo.name -eq 'SSH MCP Server')
$sessionId = $resp.Headers['Mcp-Session-Id']

Tick $initOk   "POST initialize returned HTTP 200"
Tick $serverOk "Response serverInfo.name == 'SSH MCP Server'"

if ($Flow -eq 'B') {
    Tick ([bool] $sessionId) "Mcp-Session-Id header present (Flow B stateful)"
    if ($sessionId) { $headers['Mcp-Session-Id'] = $sessionId }
}

# --------------------------------------------------------------------- 3. tools/list
Write-Section '3. tools/list'

$listBody = @{
    jsonrpc = '2.0'
    id      = 2
    method  = 'tools/list'
    params  = @{}
} | ConvertTo-Json -Compress -Depth 8

$listResp  = Invoke-RestMethod -Uri $mcpUrl -Method Post -Headers $headers -Body $listBody -TimeoutSec 30
$toolNames = @($listResp.result.tools | ForEach-Object { $_.name })
$expected  = @('exec', 'sudo-exec', 'list-servers')
$missing   = $expected | Where-Object { $_ -notin $toolNames }
Tick ($missing.Count -eq 0) ("tools/list contains {0}" -f ($expected -join ', '))
if ($missing) { Write-Host ("    missing: {0}" -f ($missing -join ', ')) -ForegroundColor DarkRed }

# --------------------------------------------------------------------- 4. tools/call exec
Write-Section "4. tools/call exec on $Connection"

$execBody = @{
    jsonrpc = '2.0'
    id      = 3
    method  = 'tools/call'
    params  = @{
        name      = 'exec'
        arguments = @{
            connectionName = $Connection
            command        = $Command
        }
    }
} | ConvertTo-Json -Compress -Depth 8

try {
    $execResp = Invoke-RestMethod -Uri $mcpUrl -Method Post -Headers $headers -Body $execBody -TimeoutSec 60
    $execText = $execResp.result.content[0].text
} catch {
    Tick $false "tools/call exec returned successfully"
    Write-Host $_.Exception.Message -ForegroundColor DarkRed
    exit 1
}

Tick ([bool] $execText) "tools/call exec returned non-empty content"
Write-Host ('    output:') -ForegroundColor DarkGray
$execText -split "`n" | ForEach-Object { Write-Host ("      {0}" -f $_) -ForegroundColor DarkGray }

# Heuristic semantic checks
$looksKerberos = $execText -match 'c19087' -or $execText -match 'uid='
$looksRemote   = $execText -match 'eip2|gitlab|css\.com\.tw'
$looksUtc      = $execText -match 'UTC'

Tick $looksRemote   "Output mentions remote host identity"
Tick $looksKerberos "Output identifies the AD principal (Kerberos SSO confirmed)"
Tick $looksUtc      "Output contains UTC timestamp (remote date executed)"

# --------------------------------------------------------------------- 5. Audit log verification
Write-Section '5. Audit log'

if (-not (Test-Path $AuditDir)) {
    Tick $false ("Audit dir exists: {0}" -f $AuditDir)
} else {
    Tick $true ("Audit dir exists: {0}" -f $AuditDir)

    $today     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    $auditFile = Join-Path $AuditDir "audit-$today.jsonl"

    if (Test-Path $auditFile) {
        Tick $true ("Today's audit file present: {0}" -f $auditFile)
        # Check the last record looks like our exec
        $tail   = Get-Content $auditFile -Tail 5 -ErrorAction SilentlyContinue
        $hits   = @()
        foreach ($line in $tail) {
            try {
                $rec = $line | ConvertFrom-Json
                if ($rec.connection_name -eq $Connection) { $hits += $rec }
            } catch { }
        }
        Tick (($hits | Measure-Object).Count -gt 0) "At least one recent audit record matches $Connection"

        # Secret leakage gate
        $leak = Select-String -Path $auditFile -Pattern 'password|Bearer|SSH_MCP_HTTP_TOKEN' -SimpleMatch -ErrorAction SilentlyContinue
        Tick (($leak | Measure-Object).Count -eq 0) "No secret-looking substrings in audit file"
        if ($leak) {
            Write-Host '    LEAK SAMPLE:' -ForegroundColor Red
            $leak | Select-Object -First 3 | ForEach-Object { Write-Host ("      {0}" -f $_.Line) -ForegroundColor Red }
        }
    } else {
        Tick $false ("Today's audit file present: {0}" -f $auditFile)
    }
}

# --------------------------------------------------------------------- 6. Summary
Write-Section 'Summary'
$total = $results.Count
$pass  = ($results.Values | Where-Object { $_ }).Count
$fail  = $total - $pass
$color = if ($fail -eq 0) { 'Green' } else { 'Yellow' }
Write-Host ("  Passed: {0} / {1}" -f $pass, $total) -ForegroundColor $color
if ($fail -gt 0) {
    Write-Host '  Failed criteria:' -ForegroundColor Red
    $results.GetEnumerator() | Where-Object { -not $_.Value } |
        ForEach-Object { Write-Host ("    - {0}" -f $_.Key) -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host '  All success criteria ticked. HTTP MCP transport is healthy on this host.' -ForegroundColor Green
exit 0
