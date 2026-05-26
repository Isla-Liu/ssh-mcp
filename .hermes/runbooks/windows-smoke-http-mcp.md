# Windows-host smoke runbook — ssh-mcp HTTP MCP transport

> Audience: a human at the Windows console (Isla). This runbook is hand-driven; the
> WSL agent cannot execute it because the LSA ticket cache + in-box `ssh.exe` only
> exist in your interactive Windows logon session. Run it on the **Windows host**,
> not inside WSL.
>
> Two flows are documented. **Flow A (mcp-proxy bridge)** is what is ACTIVE TODAY
> on this machine (per `StandaloneMcpServers.ps1`). **Flow B (in-process Streamable
> HTTP)** is what the P2 plan ships next. The first thing the runbook does is tell
> you which one you are on, so you do not waste time smoke-testing a transport that
> is not running.
>
> Companion script:  `.hermes/runbooks/windows-smoke-http-mcp.ps1`
> Use the script for the happy path; come back to this Markdown for diagnosis when
> a step fails.

---

## 0. Which transport is active?

Decision table — read once at the top of every smoke session:

| Signal                                                                                  | You are on... |
| --------------------------------------------------------------------------------------- | ------------- |
| `StandaloneMcpServers.ps1` is running AND it spawned a `mcp-proxy` child for ssh-mcp     | **Flow A**    |
| `node …\ssh-mcp-kerberos\build\index.js --transport-mcp=http` is in the process tree    | **Flow B**    |
| Neither is running                                                                      | Start the one you want to test (see §1A.1 / §1B.1) |

Quick check from PowerShell:

```powershell
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'ssh-mcp|mcp-proxy' } |
    Select-Object ProcessId, Name, CommandLine | Format-List
```

If you see `npx -y mcp-proxy --port=8934 --host=192.168.144.1 -- node …\ssh-mcp-kerberos\build\index.js …`,
that is **Flow A** — the proxy is bridging stdio→HTTP, ssh-mcp itself is still talking stdio
on its end.

If you see `node …\ssh-mcp-kerberos\build\index.js --transport-mcp=http …`, that is **Flow B** —
ssh-mcp owns the HTTP listener natively (P2). No `mcp-proxy` child.

---

## 1. Dependencies / prerequisites / known caveats

### 1.0 Common (both flows)

Required:

- Windows 10 1803+ or Windows 11. In-box OpenSSH client (`C:\Windows\System32\OpenSSH\ssh.exe`) is required for the Kerberos transport.
- Node.js 22.x on PATH (`node -v` → `v22.*`). ssh-mcp pins `^22` and TypeScript build targets it.
- The interactive logon must be domain-joined (AD: `CSS.COM.TW` based on production config). LocalSystem / Windows Service contexts do NOT have user LSA tickets — **do not run ssh-mcp as a service**.
- ssh-mcp-kerberos checked out + built. WSL path on this machine: `\\wsl.localhost\Ubuntu-26.04\home\islaliu\Repositories\ssh-mcp-kerberos\build\index.js`. If `build/index.js` is missing or older than `src/`, rebuild with `npm run build` from inside WSL.
- WSL2 mirrored networking is on (allows WSL to reach `127.0.0.1` on the Windows host as the same loopback). `wsl --status` should show "Default Distribution: Ubuntu-26.04" and `.wslconfig` should have `networkingMode=mirrored`. If you ever switch back to NAT mode, replace every `127.0.0.1` in this runbook with the Windows host vEthernet IP.

Optional but recommended:

- A terminal with PSReadLine and a UTF-8 code page (`chcp 65001`) so the boxes around log lines render correctly.

### 1.1 Flow A (mcp-proxy, current prod)

- `npx -y mcp-proxy` must succeed. This means the user's npm registry / corp proxy must work — if `HTTPS_PROXY` is set on the Windows host, the npm cache must already have `mcp-proxy@*` resolved, or your launch will hang on first fetch. Pre-warm with `npx -y mcp-proxy --help`.
- Port **8934** must be free on `192.168.144.1` (the Hyper-V vSwitch host-side IP). `Test-NetConnection -ComputerName 192.168.144.1 -Port 8934` should return `TcpTestSucceeded : False` *before* you start, `True` after.
- Hyper-V firewall rule `_Mcp Servers Allow Wsl only` must exist and be enabled — it scopes the listener to the WSL subnet `192.168.144.0/20`. Verify with `Get-NetFirewallRule -DisplayName '_Mcp Servers Allow Wsl only' | Select-Object Enabled, Profile`.
- **No bearer token.** mcp-proxy currently runs without authentication; the firewall rule is the only perimeter. Treat this as "trusted single-tenant LAN only". Flow B fixes this.

### 1.2 Flow B (in-process Streamable HTTP, P2)

- Requires that the P2 implementation is merged: `src/http-listener.ts` exists, `src/index.ts` parses `--transport-mcp`, TOML schema knows `[server.http]`. If `node build/index.js --transport-mcp=http --help` errors with "unknown option", **the build is not P2-ready — fall back to Flow A**.
- TOML config at `%USERPROFILE%\.ssh-mcp\config.toml` with a `[server.http]` block (sample in §2B).
- Bearer token in `SSH_MCP_HTTP_TOKEN` environment variable — set in the user session before launch (Task Scheduler env, or the launcher PS sets it inline).
- Bind to `127.0.0.1:8934` (TOML default; matches port policy — Hyper-V `_Mcp Servers Allow Wsl only` already opens 8931–8939 for the WSL subnet). With WSL mirrored networking, `127.0.0.1:8934` on the Windows host IS reachable from WSL — no firewall rule needed, no vSwitch IP. The orchestrator can move the port within 8931–8939 with no firewall change.
- Audit log directory `%USERPROFILE%\.ssh-mcp\` (default) or whatever you set in `[server].audit_dir` must be writable (created on first boot if missing). File pattern: `executions-YYYYMMDD.jsonl`.

### 1.3 Known caveats (both flows)

| Caveat                                                                  | Why                                                                                                  | Workaround                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Each `exec` call spawns a fresh `ssh.exe` and does a full Kerberos AP-REQ. ~100–300ms latency. | Win32-OpenSSH does not support ControlMaster (PowerShell/Win32-OpenSSH#1328). | Acceptable for interactive use; do not benchmark like a bulk-exec runner.|
| `klist`-populated MIT ticket caches are NOT visible to in-box `ssh.exe`. | In-box ssh.exe is linked against SSPI, not MIT GSSAPI64.DLL.                                          | Use the LSA cache (domain logon), or install Git-for-Windows ssh.exe and `PATH` it first. |
| The hostname you SSH to must be the **FQDN** matching the SPN, not a short name or IP. | Windows SSPI builds the SPN automatically from the hostname argument.                                  | Always pass `host=eip2-db.css.com.tw`, never `eip2-db` or `10.x.x.x`.       |
| WebUI (if enabled, port separate from MCP) binds loopback and is reachable from WSL via mirrored networking. | Same loopback. Surprising if you expected WSL isolation.                                | Document; treat WSL as same-trust-zone as the Windows user.                 |

---

## 2. Sample configuration

### 2A. Flow A — no ssh-mcp TOML needed

`StandaloneMcpServers.ps1` passes target SSH configs as `--ssh=<JSON>` flags directly
to ssh-mcp's argv. Today the two pinned hosts are:

```json
{"name":"EIP2-DB","host":"eip2-db.css.com.tw","port":22,"user":"c19087@css.com.tw","auth":"kerberos"}
{"name":"css-k-gitlab","host":"css-k-gitlab.css.com.tw","port":22,"user":"c19087@css.com.tw","auth":"kerberos"}
```

There is no `config.toml` to edit. Tunables live in the launcher script.

### 2B. Flow B — `%USERPROFILE%\.ssh-mcp\config.toml`

Create the file (UTF-8, no BOM):

```toml
# %USERPROFILE%\.ssh-mcp\config.toml
# Per planner P2 (.hermes/plans/2026-05-26_P2_http-mcp-transport_windows-kerberos.md §2)

[server.http]
enabled            = true
bind               = "127.0.0.1"
port               = 8934
auth_token_env     = "SSH_MCP_HTTP_TOKEN"
origin_allowlist   = ["http://localhost", "http://127.0.0.1"]
request_timeout_ms = 60000

[approval]
mode = "manual"          # yolo | smart | manual; manual requires WebUI

[webui]
enabled = false           # leave off for the smoke test; flip on once you trust the surface

[[sources]]
id = "EIP2-DB"
host = "eip2-db.css.com.tw"
port = 22
user = "c19087@css.com.tw"
auth = "kerberos"

[[sources]]
id = "css-k-gitlab"
host = "css-k-gitlab.css.com.tw"
port = 22
user = "c19087@css.com.tw"
auth = "kerberos"
```

Then in the user session, before launching ssh-mcp:

```powershell
# Generate once; persist as a User env var so launches inherit it.
$tok = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | % {[char]$_})
[Environment]::SetEnvironmentVariable('SSH_MCP_HTTP_TOKEN', $tok, 'User')
# Open a fresh shell so the new env var is visible.
```

---

## 3. Verify Kerberos ticket (BOTH flows; do this first)

```powershell
klist
```

Expected: at least one ticket for `krbtgt/CSS.COM.TW@CSS.COM.TW` with a future `End Time:`. Service tickets for `host/eip2-db.css.com.tw` or similar appear after the first successful SSH.

If `klist` shows "No Kerberos tickets currently logged on" or "Current LogonId is 0:0x...":

- **Domain-joined, normal logon (typical):** lock the screen and unlock with your password, or run `klist purge` then `runas /netonly /user:CSS\c19087 cmd.exe` to re-seed. A full sign-out / sign-in always works.
- **Off-domain or VPN-tunneled:** connect the corporate VPN that talks to the AD KDC first. The TGT is acquired during the network logon path.
- **Last resort (MIT KfW installed):** `kinit c19087@CSS.COM.TW`. But — this populates a FILE cache that the in-box `ssh.exe` does NOT see. You would then have to swap PATH to Git-for-Windows `ssh.exe`. Skip unless you have already done that swap.

Stop here and fix Kerberos before continuing. Every smoke step below assumes a valid TGT.

---

## 4. Start ssh-mcp HTTP

### 4A. Flow A — start the production launcher

Already documented in your private notes. One liner:

```powershell
& 'D:\Repositories\McpsLaunch\StandaloneMcpServer.bat'
```

Wait for the banner that says `ssh-mcp (proxy) -> http://192.168.144.1:8934/mcp`. The window is a watchdog — keep it open for the duration of the smoke.

### 4B. Flow B — start a one-shot smoke instance

```powershell
$env:SSH_MCP_HTTP_TOKEN = [Environment]::GetEnvironmentVariable('SSH_MCP_HTTP_TOKEN','User')
$entry = '\\wsl.localhost\Ubuntu-26.04\home\islaliu\Repositories\ssh-mcp-kerberos\build\index.js'
node $entry `
    --transport-mcp=http `
    --http-bind=127.0.0.1 `
    --http-port=8934 `
    --http-token-env=SSH_MCP_HTTP_TOKEN `
    --config="$env:USERPROFILE\.ssh-mcp\config.toml"
```

Expected stdout (color may vary):

```
[ssh-mcp] starting http transport on 127.0.0.1:8934 (auth: bearer via SSH_MCP_HTTP_TOKEN)
[ssh-mcp] kerberos self-test: klist shows N tickets
[ssh-mcp] registered sources: EIP2-DB, css-k-gitlab
[ssh-mcp] listening
```

If you see `[FATAL] non-loopback bind without token`, your config has `bind = "0.0.0.0"` and no token — re-read §2B.

If you see `[WARN] anonymous loopback`, you forgot to set `SSH_MCP_HTTP_TOKEN`. Stop, set it, restart.

Keep the window open for the smoke; Ctrl+C tears it down (§7).

---

## 5. Smoke from the Windows side — three POSTs against `/mcp`

Use either `Invoke-RestMethod` (handles JSON nicely) or `curl.exe` (matches what the WSL side will run; keeps both sides comparable). The three calls are the standard MCP handshake: `initialize` → `tools/list` → `tools/call(exec)`.

PowerShell variables:

```powershell
# Flow A
$mcpUrl = 'http://192.168.144.1:8934/mcp'
$headers = @{ 'Content-Type' = 'application/json' }
# Flow B
# $mcpUrl = 'http://127.0.0.1:8934/mcp'
# $headers = @{ 'Content-Type' = 'application/json'; 'Authorization' = "Bearer $env:SSH_MCP_HTTP_TOKEN" }
```

### 5.1 initialize

```powershell
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

$init = Invoke-RestMethod -Uri $mcpUrl -Method Post -Headers $headers -Body $initBody
$init | ConvertTo-Json -Depth 8
```

Success criterion (tick each):

- [ ] HTTP 200.
- [ ] Response JSON has `result.serverInfo.name = "SSH MCP Server"` (Flow A: bridged from stdio; Flow B: direct).
- [ ] Response has `result.protocolVersion` and `result.capabilities.tools` present.
- [ ] Flow B only: response includes an `Mcp-Session-Id` header — capture for §5.2 and §5.3.

Capture session id on Flow B:

```powershell
$resp = Invoke-WebRequest -Uri $mcpUrl -Method Post -Headers $headers -Body $initBody
$sessionId = $resp.Headers['Mcp-Session-Id']
$headers['Mcp-Session-Id'] = $sessionId
```

### 5.2 tools/list

```powershell
$listBody = @{
    jsonrpc = '2.0'
    id      = 2
    method  = 'tools/list'
    params  = @{}
} | ConvertTo-Json -Compress -Depth 8

(Invoke-RestMethod -Uri $mcpUrl -Method Post -Headers $headers -Body $listBody).result.tools | Format-Table name, description
```

Success criterion:

- [ ] HTTP 200.
- [ ] `tools` array contains `exec`, `sudo-exec`, `list-servers`.
- [ ] Each tool has a non-empty `inputSchema`.

### 5.3 tools/call → exec on EIP2-DB

Pick a known-safe command that proves Kerberos auth + remote exec end-to-end:

```powershell
$execBody = @{
    jsonrpc = '2.0'
    id      = 3
    method  = 'tools/call'
    params  = @{
        name      = 'exec'
        arguments = @{
            connectionName = 'EIP2-DB'
            command        = 'hostname && id && date -u'
        }
    }
} | ConvertTo-Json -Compress -Depth 8

(Invoke-RestMethod -Uri $mcpUrl -Method Post -Headers $headers -Body $execBody).result.content[0].text
```

Success criterion:

- [ ] HTTP 200.
- [ ] Output contains the FQDN of the remote (e.g. `eip2-db`).
- [ ] Output contains your AD principal in `id` (`uid=…(c19087)` or similar SID/UID).
- [ ] Output contains a UTC timestamp from the remote.
- [ ] No password prompt anywhere in the chain (Kerberos SSO worked).

If you get `SSH authentication error`:

- Re-run §3 (`klist`). If tickets are present, the FQDN is probably wrong — try `host` matching the SPN exactly.
- If the error mentions `Server not found in Kerberos database`, the AD KDC has no SPN for `host/<hostname>@CSS.COM.TW`. Ask infra to register it.

If you get HTTP 401 on Flow B: token mismatch. Re-check `[Environment]::GetEnvironmentVariable('SSH_MCP_HTTP_TOKEN','User')` and reopen your shell.

---

## 6. Smoke from the WSL side — confirm mirrored networking

From inside WSL (Ubuntu-26.04), run the same three calls. This proves Hermes-in-WSL can reach the Windows-host listener as advertised.

```bash
# Flow A — no auth header
MCP_URL='http://127.0.0.1:8934/mcp'
AUTH=()   # empty arg array; mirrored loopback lets WSL hit Windows 127.0.0.1
# Flow B — bearer token (read from Windows env via the launcher shim, or paste once)
# Note: Flow B also defaults to port 8934 in TOML — same URL as Flow A on loopback.
# MCP_URL='http://127.0.0.1:8934/mcp'
# AUTH=(-H "Authorization: Bearer <paste...e>")

curl -sS -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    "${AUTH[@]}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-wsl","version":"1.0.0"}}}' \
  | jq '.result.serverInfo'
```

If WSL→Windows loopback fails, fall back to the vSwitch IP:

```bash
MCP_URL='http://192.168.144.1:8934/mcp'   # Flow A vSwitch path; works regardless of mirroring
```

Success criterion:

- [ ] Same `serverInfo.name = "SSH MCP Server"` from WSL.
- [ ] Repeat the `tools/list` and `tools/call exec` from §5.2/5.3, expect identical results.
- [ ] **Flow B only:** call `tools/call` twice in succession with the same `Mcp-Session-Id` header — assert the server log shows the warm ssh connection was reused (one `authenticated` log line, not two). This validates the stateful session optimisation from P2 §3.

---

## 7. Tear down + audit verification

### 7.1 Tear down

- **Flow A:** Ctrl+C the `StandaloneMcpServer.bat` window. It runs `Stop-All` via `Register-EngineEvent PowerShell.Exiting` and `taskkill /F /T` for each child. Verify with:
  ```powershell
  Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -match 'mcp-proxy|ssh-mcp-kerberos' } |
      Select-Object ProcessId, Name
  ```
  Empty result = clean teardown. If anything lingers, `Stop-Process -Id <pid> -Force`.

- **Flow B:** Ctrl+C the `node …\build\index.js` window. ssh-mcp's signal handlers (`SIGINT`/`SIGTERM`/`exit`) close the http listener and dispose ssh connections from the registry. Verify with the same `Get-CimInstance` query, looking for any orphaned `node` matching `ssh-mcp`.

### 7.2 Audit log verification

Audit path: `%USERPROFILE%\.ssh-mcp\` (default; override with `[server].audit_dir`).

Layout: one JSONL file per UTC day, name pattern `executions-YYYYMMDD.jsonl`. Rotation triggers on the 10 MB threshold (`maxFileBytes` default; rotated files are suffixed `.1`, `.2`, …, up to `retain=10`). Day-rolled files older than `retain` days are pruned.

```powershell
$today  = (Get-Date -AsUTC).ToString('yyyyMMdd')
$audit  = Join-Path $env:USERPROFILE ".ssh-mcp\executions-$today.jsonl"
Test-Path $audit
Get-Content $audit -Tail 10 | ForEach-Object { $_ | ConvertFrom-Json } | Format-List
```

Look for one record per `exec` call you made in §5.3 and §6. Each record should have:

| Field                       | Expected                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| `ts`                        | ISO8601 UTC, within the smoke window                                  |
| `id`                        | sortable id (timestamp + random suffix)                               |
| `profile`                   | `"EIP2-DB"` (the connection name)                                     |
| `tool`                      | `"exec"` or `"sudo-exec"`                                             |
| `command`                   | sanitized + redacted form of what you sent (passwords/tokens scrubbed) |
| `approval.mode`             | `"yolo"` / `"smart"` / `"manual"` (whatever the active mode is)       |
| `approval.decision`         | `"allow"` (denied calls would have stopped at the gate)                |
| `approval.decided_by`       | `"yolo"` / `"smart-llm"` / `"manual:webui"` etc.                       |
| `exec.exit_code`            | `0`                                                                    |
| `exec.duration_ms`          | small positive number                                                 |
| `exec.stdout` / `exec.stderr` | text (capped at `audit_max_bytes` per record; `stdout_truncated`/`stderr_truncated` flag is true when capped) |
| anything `*password*`/`*token*` | **MUST be absent**. If present, file a P0 incident.                |

Note: the audit record does NOT carry transport / remote_addr / mcp_session_id fields. The HTTP listener exposes those via `buildHttpAuditFields(req, bindIsLoopback)` in `src/audit/http-context.ts`; wiring them into the audit record is captured as a follow-up after the audit-log and http-transport branches merge.

Success criterion (tick):

- [ ] N records exist where N = the number of `tools/call exec` you invoked.
- [ ] None of the records contain a secret-looking substring (`grep -iE 'password|bearer|token'` over the file should match nothing in record bodies — the redactor MUST hold).
- [ ] Timestamps are monotonic.
- [ ] `approval.decision` is `"allow"` for every record (denied calls never reach the transport).

PowerShell secret-leak grep:

```powershell
Select-String -Path $audit -Pattern 'password|Bearer|SSH_MCP_HTTP_TOKEN' -SimpleMatch
```

Expect: zero matches. Any hit = stop and report.

---

## 8. Overall success criteria checklist (paste-and-tick)

```
[ ] Kerberos TGT verified (§3)
[ ] Server started without fatal log lines (§4)
[ ] Windows-side initialize succeeded (§5.1)
[ ] Windows-side tools/list returned exec / sudo-exec / list-servers (§5.2)
[ ] Windows-side exec on EIP2-DB returned remote hostname + AD id + UTC date (§5.3)
[ ] WSL-side initialize succeeded over mirrored loopback (§6)
[ ] WSL-side exec returned identical content (§6)
[ ] Flow B only: warm session reuse confirmed (§6)
[ ] Tear down: no orphan processes (§7.1)
[ ] Audit JSONL contains one record per exec, all fields populated correctly (§7.2)
[ ] Audit JSONL contains NO password / bearer / token substrings (§7.2)
```

If all eleven boxes tick, HTTP MCP transport is healthy on this Windows host for the
flow you tested.

---

## 9. Diagnosis cheatsheet

| Symptom                                           | First thing to check                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `klist` returns no tickets                        | Lock + unlock screen; VPN; §3                                |
| `Test-NetConnection ... -Port 8934` fails (Flow A) | Launcher script not running; firewall rule disabled         |
| `Test-NetConnection 127.0.0.1 -Port 8934` fails (Flow B) | ssh-mcp boot crashed; check the node window stderr     |
| HTTP 401 on Flow B                                | Bearer token mismatch; restart shell after `setx`           |
| HTTP 403 / "DNS rebinding" on Flow B              | `allowedHosts` / `allowedOrigins` mismatch; check TOML §2B  |
| `SSH authentication error: Server not found in Kerberos database` | Wrong hostname (used short name or IP) or missing SPN |
| `exec` works on Windows but not WSL               | Mirrored networking is off; use `192.168.144.1` from WSL    |
| Audit file missing                                | First boot did not create the dir; `mkdir %USERPROFILE%\.ssh-mcp` and restart |
| Audit record contains a token / password          | **P0**. Stop the smoke; do not proceed to prod; capture the offending record and file an issue against the audit card. |

---

## 10. Provenance + linked planning artifacts

- Source plan: `.hermes/plans/2026-05-26_P2_http-mcp-transport_windows-kerberos.md`
- Source research: `.hermes/research/2026-05-26_R1_http_transport_windows_kerberos.md`
- Active production launcher: `D:\Repositories\McpsLaunch\StandaloneMcpServers.ps1` (Flow A)
- ssh-mcp source: `\\wsl.localhost\Ubuntu-26.04\home\islaliu\Repositories\ssh-mcp-kerberos\` (Windows-side path)
- Companion PS1: `.hermes/runbooks/windows-smoke-http-mcp.ps1`

Last revised: 2026-05-26 (documenter, kanban t_83770e41 — Flow B port aligned to 8934 per port policy; audit path + record-shape brought into line with the shipped store).
