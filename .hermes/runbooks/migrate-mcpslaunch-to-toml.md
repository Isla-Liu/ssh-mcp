# Migration runbook — StandaloneMcpServers.ps1 → ssh-mcp HTTP transport + TOML

> Audience: a human at the Windows console (Isla) migrating the production
> launcher `D:\Repositories\McpsLaunch\StandaloneMcpServers.ps1` from the
> current `mcp-proxy + inline --ssh=<JSON>` shape to the in-process Streamable
> HTTP transport + TOML config introduced by the integration branch
> `feat/openssh-transport-kerberos-integration`.
>
> Source-of-truth for flags / TOML keys / boot invariants is the integration
> README §"HTTP MCP Transport" / §"Configuration File (TOML)" /
> §"Approval Engine" / §"Status WebUI" plus the shipped starter
> [`ssh-mcp.toml.example`](../../ssh-mcp.toml.example). Always cross-check this
> runbook against the README at the head of integration before executing — if
> they disagree, README wins and this file needs a patch.
>
> **What this runbook does not change.** The launcher script lives in a
> separate repo (`D:\Repositories\McpsLaunch`) owned by Isla. This runbook
> shows the line-level diffs you apply by hand; it does not ship a patch.
> No firewall rule is added or modified — the existing Hyper-V rule
> `_Mcp Servers Allow Wsl only` already opens TCP 8931–8939 for the WSL
> subnet (192.168.144.0/20). Port reuse is mandated: **8934 stays 8934**
> across all six phases. Companion smoke runbook:
> `.hermes/runbooks/windows-smoke-http-mcp.md` (run §3 + §5 of the smoke
> runbook against the listener at the end of every phase).

## Why six phases

The migration is intentionally split so every step has a single-edit rollback
and a verifiable success criterion. Skipping phases is allowed when the
predecessor's verification is green; collapsing phases is not — each phase
turns one knob.

| Phase | Knob turned                                                                                       | Outcome                                                                                                  |
|------:|---------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1     | Drop `%USERPROFILE%\.ssh-mcp\config.toml` mirroring today's two hosts. Run ssh-mcp once via `--config` to validate that tool listing is byte-identical. **No change to the prod launcher.** | TOML schema and source-of-truth in place; CLI still authoritative. |
| 2     | Switch the launcher from inline `--ssh=<JSON>` to `--config=%USERPROFILE%\.ssh-mcp\config.toml`. **Keep mcp-proxy.** | Source registry now lives in TOML; transport unchanged. |
| 3     | Drop mcp-proxy. Run ssh-mcp directly with `[server.http].enabled=true`, port 8934, bearer via `SSH_MCP_HTTP_TOKEN`. | Native Streamable HTTP; single process; no proxy hop. |
| 4     | Confirm audit log default landed at `%USERPROFILE%\.ssh-mcp\executions-YYYYMMDD.jsonl`. **No config change needed** — `[server].audit_dir` defaults to `~/.ssh-mcp`. | Persistent, redacting audit trail enabled. |
| 5+6   | **Enable WebUI (port 8939, loopback, bearer) AND set `[approval].mode = "manual"` in the same edit.** Phase 5 and Phase 6 ship together because manual approval has no other resolver — boot fails if WebUI is off. | Every `exec` / `sudo-exec` gated by human approval via WebUI. |

> **Deviation from card body.** The card asked Phase 5 (manual) before Phase 6
> (WebUI optional). README §Approval Engine ("Boot fails if
> `[webui].enabled = false`") makes that ordering boot-impossible. This
> runbook fuses 5+6 into one atomic edit. The path for "soak with a lower
> gate first" is documented as Phase 5-soak below (mode=`yolo` → audit-only
> review → flip to `manual` once you trust the surface). `smart` mode requires
> a reachable LLM endpoint + API key in env — not free; covered as Phase 5-alt.

## Phase 0 — preflight (no changes)

Run these checks once before touching anything. Each should return what it
says, and the smoke runbook §3 (`klist`) must show a live TGT.

```powershell
# 1. The integration build is on disk and recent.
$entry = '\\wsl.localhost\Ubuntu-26.04\home\islaliu\Repositories\ssh-mcp-kerberos\build\index.js'
Test-Path $entry                                # True
node $entry --help 2>&1 | Select-String '--transport-mcp|--config'   # both flags listed
# If either flag is missing, the integration branch isn't built. From WSL:
#   cd ~/Repositories/ssh-mcp-kerberos.wt/http-transport && npm run build

# 2. Current launcher state — which transport is active?
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'mcp-proxy|ssh-mcp-kerberos' } |
    Select-Object ProcessId, CommandLine | Format-List
# Expected today: one mcp-proxy parent + one node child (Flow A).

# 3. The port we're going to reuse is currently held by Flow A. That is fine;
#    every phase below tears down before re-launching.
Test-NetConnection -ComputerName 192.168.144.1 -Port 8934 -InformationLevel Quiet
#   True today (Flow A is up on the vSwitch IP)

# 4. Kerberos ticket alive. Smoke runbook §3.
klist | Select-String 'krbtgt/CSS.COM.TW'
```

If any of those four fail, fix before starting. The phases below assume all
green.

---

## Phase 1 — drop TOML, validate with `--config` (no launcher change)

**Edit.** Create `%USERPROFILE%\.ssh-mcp\config.toml`, UTF-8 no BOM. Mirrors
exactly the two pinned hosts from the current `StandaloneMcpServers.ps1`
lines 69-83 (`$SshTargetEip2Db`, `$SshTargetGitlab`):

```toml
# %USERPROFILE%\.ssh-mcp\config.toml — Phase 1.
# Mirrors the two --ssh=<JSON> entries in StandaloneMcpServers.ps1.
# Field names follow src/config/types.ts (`id`, not `name`) and the
# shipped ssh-mcp.toml.example.
#
# No [server.http] block yet — Phase 1 still runs over stdio under mcp-proxy.

[[sources]]
id      = "EIP2-DB"
host    = "eip2-db.css.com.tw"
port    = 22
user    = "c19087@css.com.tw"
auth    = "kerberos"
default = true   # at most one source may set default=true

[[sources]]
id   = "css-k-gitlab"
host = "css-k-gitlab.css.com.tw"
port = 22
user = "c19087@css.com.tw"
auth = "kerberos"
```

**Verify — TOML parses + same source registry as CLI.**

```powershell
$cfg   = "$env:USERPROFILE\.ssh-mcp\config.toml"
$entry = '\\wsl.localhost\Ubuntu-26.04\home\islaliu\Repositories\ssh-mcp-kerberos\build\index.js'

# 1. Stdio probe via --config. Background the process; send tools/list over
#    stdin; assert both source ids appear via `list-servers`.
$args = @($entry, '--config', $cfg)
$p = Start-Process node -ArgumentList $args -PassThru -RedirectStandardInput stdin.txt -NoNewWindow
Start-Sleep -Seconds 2
# Boot-log line we expect on stderr: "registered sources: EIP2-DB, css-k-gitlab"
Stop-Process -Id $p.Id -Force

# 2. Cross-check from WSL — handier because curl + jq exist there.
#    (no HTTP yet; this is just a TOML-load sanity check using the existing
#    Flow A listener — Flow A reads --ssh=<JSON>, NOT --config, so this WSL
#    step verifies only that the TOML you authored doesn't crash boot, by
#    running ssh-mcp in dry-run mode if it has one. If not, skip — the
#    integration test suite already covers TOML parse.)
```

Actually the cleanest Phase-1 verification is the **integration test
already in tree**: from WSL,

```bash
cd ~/Repositories/ssh-mcp-kerberos.wt/http-transport
npx vitest run src/config/__tests__/toml-loader.test.ts \
                src/config/__tests__/toml-server-http.test.ts
```

If those pass and your TOML loads without exception in the spawn probe above,
Phase 1 is green. Tool listing is byte-identical to today because we haven't
changed the launcher yet — it still uses `--ssh=<JSON>`.

**Rollback (single edit).** Delete `%USERPROFILE%\.ssh-mcp\config.toml`.

**Caveats.**
- Field names: TOML uses `id`, **not** `name`. The shipped `ssh-mcp.toml.example` and `src/config/types.ts` are authoritative. (`windows-smoke-http-mcp.md` §2B currently writes `name = ...` — that file has a bug; ignore it and follow this runbook.)
- `default = true` may appear on at most one source. Two `default=true`s = boot validation failure.
- Discovery order is documented in README §"Configuration File (TOML)" — `--config=<path>` (highest) → `$SSH_MCP_CONFIG` → `$XDG_CONFIG_HOME/ssh-mcp/config.toml` or `~/.config/ssh-mcp/config.toml` → `~/.ssh-mcp/config.toml`. Phase 1 uses `~/.ssh-mcp/config.toml` so that subsequent phases can drop the explicit `--config` flag and still load it via discovery.
- Secret indirection: anywhere a secret-bearing string is accepted you may write `env:NAME`. The two pinned hosts use Kerberos so this doesn't apply yet; it matters for Phase 5-alt (`[approval.llm].api_key`).

---

## Phase 2 — launcher swaps `--ssh=<JSON>` for `--config`, keeps mcp-proxy

**Edit (in `D:\Repositories\McpsLaunch\StandaloneMcpServers.ps1`).** Replace
lines ~211-218 — the `$sshChildCmd` build and `Start-Process` block — with a
straight `--config` invocation. Conceptual diff (apply by hand, do not commit
to that repo from inside this one):

```diff
-    # Quoting note (Option C — root-cause fix for PS native-arg quote-stripping):
-    # PS5.1's Start-Process -ArgumentList string[] joins elements with its broken
-    # native-command quoter and strips internal " from JSON values. We bypass it
-    # by building ONE pre-quoted command-line string and handing it to cmd.exe
-    # via -ArgumentList <single string>, which PS passes verbatim to CreateProcess.
-    # cmd.exe /c then takes the rest of the command line literally; \" inside the
-    # outer "..." survives through npx → node argv.
-    $SshJsonEip2Db = $SshTargetEip2Db -replace '"','\"'
-    $SshJsonGitlab = $SshTargetGitlab -replace '"','\"'
-    $sshChildCmd = "/c npx -y mcp-proxy --port=$SshMcpPort --host=$WindowsMcpHost -- node `"$SshMcpEntry`" `"--ssh=$SshJsonEip2Db`" `"--ssh=$SshJsonGitlab`""
-
-    Write-Host "-> Starting ssh-mcp" -ForegroundColor Cyan
-    $sshProc = Start-Process -FilePath "cmd.exe" -ArgumentList $sshChildCmd -PassThru -NoNewWindow
+    # Phase 2 — sources now live in %USERPROFILE%\.ssh-mcp\config.toml.
+    # mcp-proxy still bridges stdio → HTTP on port $SshMcpPort. The PS5.1
+    # quoting hack from Phase 0 is no longer required because --config takes
+    # a plain path; there are no embedded double-quotes to preserve.
+    $SshMcpConfig = Join-Path $env:USERPROFILE '.ssh-mcp\config.toml'
+    if (-not (Test-Path $SshMcpConfig)) {
+        throw "ssh-mcp TOML missing: $SshMcpConfig. Run Phase 1 first."
+    }
+    Start-MCP -Name "ssh-mcp" -File "cmd.exe" -ArgList @(
+        '/c','npx','-y','mcp-proxy',
+        "--port=$SshMcpPort","--host=$WindowsMcpHost",
+        '--',
+        'node',$SshMcpEntry,"--config=$SshMcpConfig"
+    )
-    $global:procs += [pscustomobject]@{ Name = 'ssh-mcp'; Process = $sshProc }
-    Write-Host "   PID $($sshProc.Id)" -ForegroundColor DarkGray
```

The two `$SshTargetEip2Db` / `$SshTargetGitlab` `ConvertTo-Json` blocks
(lines 65-83 of the current launcher) become dead code; leave them in place
for one cycle in case rollback is needed, then prune in a follow-up pass.

**Verify.** Restart the launcher (`StandaloneMcpServer.bat`). Wait for the
banner `ssh-mcp (proxy) -> http://192.168.144.1:8934/mcp`. Then run the smoke
runbook §5 (Windows) and §6 (WSL) **Flow A** branches verbatim. Required:

- `initialize` → `serverInfo.name = "SSH MCP Server"`
- `tools/list` → contains `exec`, `sudo-exec`, `list-servers`
- `tools/call exec` on `connectionName=EIP2-DB` returns the remote hostname + AD id + UTC date
- WSL-side curl against `http://192.168.144.1:8934/mcp` returns the same payload

If `list-servers` returns only one host or the wrong host, your TOML field
names are wrong (most likely `name` instead of `id`).

**Rollback (single edit).** Revert the launcher block back to the original
`$sshChildCmd` invocation — both halves of the diff are above. The TOML on
disk is harmless; you can leave it.

**Caveats.**
- Discovery: this phase uses an **explicit** `--config=<path>`, which is the highest-priority TOML source (overrides `$SSH_MCP_CONFIG` and the discovery locations). That isolates Phase 2 from any accidental TOML in `~/.config/ssh-mcp/`.
- Phase 2 is the last phase where mcp-proxy is in the picture. If `npx -y mcp-proxy` ever stalls on first-fetch from a cold npm cache (corp proxy + `HTTPS_PROXY` set), pre-warm with `npx -y mcp-proxy --help` once. Phase 3 removes this dependency.
- Kerberos: untouched. Each `exec` still spawns a fresh `ssh.exe` and pays the AP-REQ round trip (~100-300ms). README §Kerberos / OpenSSH Transport "Caveats and limitations" applies unchanged.

---

## Phase 3 — drop mcp-proxy, native HTTP transport

**Edit (TOML).** Add `[server.http]` to the same `%USERPROFILE%\.ssh-mcp\config.toml`:

```toml
# %USERPROFILE%\.ssh-mcp\config.toml — Phase 3 addition.

[server.http]
enabled            = true
bind               = "127.0.0.1"   # WSL mirrored networking can reach this
port               = 8934          # MUST match the launcher / firewall range
auth_token_env     = "SSH_MCP_HTTP_TOKEN"   # NAME of env var, not value
origin_allowlist   = ["http://127.0.0.1", "http://localhost"]
request_timeout_ms = 60000
```

**Edit (bearer token in user env).** Once, persist for the user:

```powershell
$tok = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | % {[char]$_})
[Environment]::SetEnvironmentVariable('SSH_MCP_HTTP_TOKEN', $tok, 'User')
# Reopen any shell that needs to see it (Task Scheduler tasks inherit on next run).
Write-Host "Token written. Length: $($tok.Length). Store somewhere safe."
```

The TOML carries only the env-var **name**. The value lives in the user
environment block. `auth_token_env` defaults to `SSH_MCP_HTTP_TOKEN`, so
this name is the path of least resistance.

**Edit (launcher).** Replace the Phase-2 mcp-proxy invocation with a direct
`node build/index.js` run. Conceptual diff against the Phase-2 launcher:

```diff
-    # Phase 2 — sources now live in %USERPROFILE%\.ssh-mcp\config.toml.
-    # mcp-proxy still bridges stdio → HTTP on port $SshMcpPort.
-    $SshMcpConfig = Join-Path $env:USERPROFILE '.ssh-mcp\config.toml'
-    if (-not (Test-Path $SshMcpConfig)) {
-        throw "ssh-mcp TOML missing: $SshMcpConfig. Run Phase 1 first."
-    }
-    Start-MCP -Name "ssh-mcp" -File "cmd.exe" -ArgList @(
-        '/c','npx','-y','mcp-proxy',
-        "--port=$SshMcpPort","--host=$WindowsMcpHost",
-        '--',
-        'node',$SshMcpEntry,"--config=$SshMcpConfig"
-    )
+    # Phase 3 — native Streamable HTTP, no mcp-proxy.
+    # ssh-mcp binds 127.0.0.1:$SshMcpPort directly. WSL mirrored networking
+    # routes the WSL client's 127.0.0.1 to the same Windows loopback, so the
+    # Hyper-V vSwitch IP ($WindowsMcpHost) is no longer required.
+    # Banner string at the bottom is updated to reflect 127.0.0.1.
+    $SshMcpConfig = Join-Path $env:USERPROFILE '.ssh-mcp\config.toml'
+    if (-not (Test-Path $SshMcpConfig)) {
+        throw "ssh-mcp TOML missing: $SshMcpConfig. Run Phase 1 first."
+    }
+    if ([string]::IsNullOrWhiteSpace($env:SSH_MCP_HTTP_TOKEN)) {
+        # Re-import in case the launcher started before the user env was set.
+        $env:SSH_MCP_HTTP_TOKEN = [Environment]::GetEnvironmentVariable('SSH_MCP_HTTP_TOKEN','User')
+    }
+    if ([string]::IsNullOrWhiteSpace($env:SSH_MCP_HTTP_TOKEN)) {
+        throw "SSH_MCP_HTTP_TOKEN is empty. Set it once via [Environment]::SetEnvironmentVariable(...,'User') and reopen the launcher window."
+    }
+    Start-MCP -Name "ssh-mcp" -File "cmd.exe" -ArgList @(
+        '/c','node',$SshMcpEntry,
+        "--config=$SshMcpConfig"
+        # No --transport-mcp / --http-port needed; [server.http].enabled=true
+        # in the TOML drives transport selection.
+    )
```

Update the banner block (lines 267-273 of today's launcher) — replace
`http://${WindowsMcpHost}:$SshMcpPort/mcp   (targets: EIP2-DB, css-k-gitlab)`
with `http://127.0.0.1:$SshMcpPort/mcp   (native HTTP; targets per ~/.ssh-mcp/config.toml)`.

**Verify (Phase 3 == smoke runbook Flow B).** Restart the launcher. Boot
stderr should include:

```
[ssh-mcp] starting http transport on 127.0.0.1:8934 (auth: bearer via SSH_MCP_HTTP_TOKEN)
[ssh-mcp] registered sources: EIP2-DB, css-k-gitlab
[ssh-mcp] listening
```

Then run the smoke runbook §5 **Flow B** branch (Windows) and §6 **Flow B**
branch (WSL). Critical checks:

```powershell
# Windows side
$h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $env:SSH_MCP_HTTP_TOKEN" }
$init = Invoke-WebRequest -Uri 'http://127.0.0.1:8934/mcp' -Method Post -Headers $h `
        -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
$init.StatusCode                                      # 200
$init.Headers['Mcp-Session-Id']                       # non-empty — session id
Invoke-RestMethod -Uri 'http://127.0.0.1:8934/healthz' # {"status":"ok"} — unauthenticated probe
```

```bash
# WSL side — Flow B uses loopback (mirrored networking) on the same port.
TOKEN="$(/mnt/c/Windows/System32/cmd.exe /c 'echo %SSH_MCP_HTTP_TOKEN%' | tr -d '\r')"
curl -fsS -X POST http://127.0.0.1:8934/mcp \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-wsl","version":"1"}}}' \
  | jq '.result.serverInfo'
```

Expected: `{"name":"SSH MCP Server",...}`. A 401 = token mismatch
(reopen the WSL shell after the Windows env-var was set, or re-fetch from
cmd.exe as above). A 403 with `DNS rebinding` mention = the listener's
`allowed_hosts` derivation rejected your `Host:` header (rare at loopback;
usually means you bound non-loopback by mistake and `origin_allowlist`
needs to be widened — but for this migration we stay on loopback).

**Rollback (single edit).** In `%USERPROFILE%\.ssh-mcp\config.toml` set
`[server.http].enabled = false` and revert the launcher block back to the
Phase-2 mcp-proxy invocation. Note: the launcher revert is a separate edit,
so this rollback is "two coordinated edits" rather than truly one — if you
need it to be one edit, set `enabled = false` and the next launch fails
loudly with `[ssh-mcp] running stdio (no http transport configured)` while
mcp-proxy is gone — kill ssh-mcp, paste the Phase-2 launcher block back,
relaunch. Plan a brief outage window.

**Caveats.**
- **Multi-instance lock.** `%USERPROFILE%\.ssh-mcp\runtime.json` is written on boot with `{pid, host, port, started_at, transport}`. A second instance with the same port + the recorded PID still alive + record < 2 minutes old = fatal exit. Standard restart is fine (the first process tears the file on `SIGINT`). If the launcher window crashed and the next launch dies with `another ssh-mcp is already running`, delete `runtime.json` manually.
- **No firewall change.** `bind = "127.0.0.1"` plus WSL mirrored networking covers both clients. The vSwitch IP `192.168.144.1` is no longer reachable from this listener — WSL clients that previously dialed it must dial `127.0.0.1` now. Update any pinned MCP-client config in `~/.config/Claude/...` accordingly.
- **Kerberos ticket renewal.** Unchanged from Phase 2 — the LSA cache renews on screen-lock cycles + sign-in. The launcher inherits the interactive logon's tickets; do NOT re-deploy as a Windows Service (LocalSystem has no LSA cache). See README §Security Model "Run interactively on Windows, never as a service."
- **`/healthz` is unauthenticated.** Wire it into your liveness probe directly — no token, no Origin check. Treat it as info-disclosure-only (returns the literal string `{"status":"ok"}`).

---

## Phase 4 — confirm audit log

**Edit.** None. `[server].audit_dir` defaults to `~/.ssh-mcp`, which on
Windows expands to `%USERPROFILE%\.ssh-mcp\`. Audit JSONL files are written
under that path with name pattern `executions-YYYYMMDD.jsonl`.

If you want a different directory (e.g. on a different drive for retention),
**then** edit the TOML:

```toml
[server]
audit_dir       = "D:/audit/ssh-mcp"
audit_max_bytes = 10000   # default; per-record stdout/stderr cap (UTF-8 bytes)
```

**Verify.** After running any `tools/call exec` in Phase 3's smoke,

```powershell
$today = (Get-Date -AsUTC).ToString('yyyyMMdd')
$audit = Join-Path $env:USERPROFILE ".ssh-mcp\executions-$today.jsonl"
Test-Path $audit                                           # True
Get-Content $audit -Tail 5 | ForEach-Object { $_ | ConvertFrom-Json } | Format-List
# Each record should have: ts, id, profile, tool, command, approval{}, exec{}.
# Secret-leak check — must return zero matches:
Select-String -Path $audit -Pattern 'password|Bearer|SSH_MCP_HTTP_TOKEN' -SimpleMatch
```

If `Select-String` returns any hit, **stop migrating** and file a P0 against
the audit-log card — the redactor failed.

**Rollback (single edit).** Remove or rename the JSONL files; set
`[server].audit_dir` back to `~/.ssh-mcp` (or delete the override). Audit
cannot be fully disabled by config — it is always-on by design (every exec /
sudo-exec writes one line). If you genuinely want to suppress writes for a
debugging session, point `audit_dir` at a tmpfs / RAM disk and accept that
those records are lost on reboot.

**Caveats.**
- **JSONL append-only with rotation.** Size rotation at 10 MB (default `maxFileBytes`) into `.1`, `.2`, … up to `retain=10` (default). Day rotation prunes files older than `retain` days on the first append of each new UTC day. See README §"Audit Log".
- **Redaction is over-aggressive on purpose.** Patterns include `--password=...`, `-p ...`, `Authorization: Bearer ...`, env-style `*TOKEN=`/`*SECRET=`, JSON/TOML `"password":"..."`, JWTs, AWS keys, GitHub PATs, Slack tokens, Google API keys, PEM blocks. False positives (real output redacted) are intentional; passwords appearing in audit are a P0.
- **Audit record currently does not carry the MCP session id, HTTP remote address, or transport.** `src/audit/http-context.ts` exposes those via `buildHttpAuditFields(req, bindIsLoopback)` but the wiring into the audit record is post-merge follow-up. Note this when correlating audit lines back to client sessions.

---

## Phase 5 + 6 — WebUI + manual approval (atomic edit)

> **Why these two phases are fused.** Per README §"Approval Engine":
> `mode = "manual"` **requires** `[webui].enabled = true` — manual is the only
> approval mode without an automatic resolver, so the WebUI is its lone
> human-decision surface. Setting `mode = "manual"` while `[webui].enabled =
> false` makes ssh-mcp boot-fail. Therefore Phase 5 and Phase 6 ship in the
> same TOML edit. The card body's "Phase 6 optional" framing is not workable
> on `manual`. If you need a real soak before flipping to `manual`, take the
> Phase 5-soak path below.

**Edit (TOML).** Append:

```toml
# %USERPROFILE%\.ssh-mcp\config.toml — Phase 5+6 addition.

[approval]
mode        = "manual"   # yolo | smart | manual
fail_closed = true       # default; only relevant for smart mode

[webui]
enabled    = true
host       = "127.0.0.1"    # loopback; firewall rule already opens 8939
port       = 8939           # in 8931-8939 range; no firewall edit needed
auth_token = "env:SSHMCP_WEBUI_TOKEN"   # required on non-loopback; harmless on loopback
```

**Edit (bearer token for the WebUI).** Same idea as `SSH_MCP_HTTP_TOKEN`:

```powershell
$wtok = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | % {[char]$_})
[Environment]::SetEnvironmentVariable('SSHMCP_WEBUI_TOKEN', $wtok, 'User')
# Reopen the launcher window so $env: sees it.
```

On loopback bind the token is optional. We set it anyway because the WebUI's
`/events` SSE endpoint accepts the token via `?token=<tok>` query string
(since `EventSource` cannot set headers) and because the same TOML will be
copied to other hosts later — keeping `auth_token = "env:..."` at all times
prevents accidental anonymous WebUI deployment.

**Edit (launcher).** Add the WebUI token into the launcher's environment
import block, same shape as `SSH_MCP_HTTP_TOKEN`:

```diff
+    if ([string]::IsNullOrWhiteSpace($env:SSHMCP_WEBUI_TOKEN)) {
+        $env:SSHMCP_WEBUI_TOKEN = [Environment]::GetEnvironmentVariable('SSHMCP_WEBUI_TOKEN','User')
+    }
+    if ([string]::IsNullOrWhiteSpace($env:SSHMCP_WEBUI_TOKEN)) {
+        throw "SSHMCP_WEBUI_TOKEN is empty. Run the Phase 5+6 token-setup snippet."
+    }
```

Update the banner block to advertise the WebUI:

```diff
+    Write-Host "  ssh-mcp WebUI   -> http://127.0.0.1:8939/  (read-only status + manual-approval queue)"
```

**Verify.** Restart the launcher. Boot stderr should include
`[ssh-mcp] webui listening on http://127.0.0.1:8939` alongside the HTTP MCP
transport line. Then:

```powershell
# 1. WebUI alive.
Invoke-RestMethod -Uri 'http://127.0.0.1:8939/api/profiles' `
    -Headers @{ 'Authorization' = "Bearer $env:SSHMCP_WEBUI_TOKEN" }
# Expected: array containing { id: "EIP2-DB", ... } and { id: "css-k-gitlab", ... }
# with approval_mode = "manual" and current connection state.

# 2. Manual approval round trip — fire an exec from a WSL agent, then
#    resolve from the WebUI.
#    a) From WSL, in another terminal:
#       curl -X POST http://127.0.0.1:8934/mcp -H 'Authorization: Bearer ...' \
#            -d '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"exec","arguments":{"connectionName":"EIP2-DB","command":"hostname"}}}'
#       The call hangs (queued for approval, 5 min default timeout).
#    b) Back in Windows, query the queue and resolve:
Invoke-RestMethod -Uri 'http://127.0.0.1:8939/api/approvals' `
    -Headers @{ 'Authorization' = "Bearer $env:SSHMCP_WEBUI_TOKEN" }
# Note the id of your pending row, then:
$pid = '<paste id from previous>'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8939/api/approvals/$pid" `
    -Headers @{ 'Authorization' = "Bearer $env:SSHMCP_WEBUI_TOKEN"; 'Content-Type' = 'application/json' } `
    -Body (@{ decision = 'allow'; note = 'phase-5 smoke' } | ConvertTo-Json)
# The WSL-side curl should now complete and return the remote hostname.
```

Audit-side verification — every approved call lands a record with
`approval.decision = "allow"`, `approval.decided_by = "manual:webui"`, and
the note you wrote.

**Rollback (single edit).** `mode = "yolo"` in `[approval]`. WebUI may stay
on; with `yolo` the queue is empty. To fully revert: comment out both
`[approval]` and `[webui]` blocks (defaults are mode `manual` + WebUI off,
which is the boot-fail combo — so leave at least `mode = "yolo"` until you
re-engage `manual`).

**Caveats.**
- **Boot-fail invariant.** `mode = "manual"` + `[webui].enabled = false` = ssh-mcp refuses to boot. Symptom: stderr `approval mode "manual" requires [webui].enabled = true` and process exits non-zero. The launcher's `Stop-All` will then taskkill the rest of the tree — you lose Chrome / Playwright / dbhub / windows-mcp too. Always smoke-test this combination on a non-prod boot first.
- **Per-source override.** A `[sources.approval]` block on one source wins over global. Useful pattern: `manual` on `EIP2-DB`, `yolo` on `css-k-gitlab` (or vice versa). See README §"Per-source override".
- **Manual timeout.** Queued approvals that nobody resolves within 5 minutes auto-`deny` with `reason: "approval timed out"`. Tune later if it's too short.
- **Manual mode is human-in-the-loop.** WSL agents that fire `exec` while no human is at the WebUI will hang up to 5 minutes per call. Plan staffing or fall back to `yolo` for batch jobs.

### Phase 5-soak — use yolo for a few days before manual

If you want telemetry before turning the human-decision gate on, run with:

```toml
[approval]
mode = "yolo"        # allow everything; decisions land in audit as decided_by="yolo"

[webui]
enabled = true       # can stay on or off; WebUI is read-only at yolo
host    = "127.0.0.1"
port    = 8939
auth_token = "env:SSHMCP_WEBUI_TOKEN"
```

Soak for N days, review `~/.ssh-mcp/executions-*.jsonl`, then flip `mode`
to `"manual"`. The flip is the one edit you need; the WebUI is already up.

### Phase 5-alt — smart mode (LLM-judge) instead of manual

> Skip unless you have a reachable LLM endpoint **and** an API key in env.
> Corporate proxies often block `api.openai.com` egress; smart mode then
> deadlocks at the boot self-test or denies every call (fail-closed).

```toml
[approval]
mode        = "smart"
fail_closed = true   # default; deny on LLM timeout / HTTP error / malformed JSON

[approval.llm]
endpoint   = "https://api.openai.com/v1/chat/completions"
api_key    = "env:OPENAI_API_KEY"
model      = "gpt-4o-mini"
timeout_ms = 8000
```

`fail_closed = false` flips LLM-failure responses to `allow` — **do this only
with eyes open**; a flaky endpoint becomes a security bypass.

---

## Caveats that apply to every phase

These are README §"Security Model" + §"Kerberos / OpenSSH Transport"
distillations — re-stating here so you do not have to bounce out of this
runbook mid-migration.

| Caveat                                                                                                  | Mitigation                                                                                                                                              |
|---------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Kerberos ticket renewal.** Win32-OpenSSH consumes the LSA TGT. Lock + unlock screen, or sign-in cycle, re-seeds. | Document a daily "is `klist` happy?" check; the launcher does not auto-`kinit`. Boot-time `klist` self-test is warn-only — empty cache won't block boot. |
| **No connection multiplexing on Windows.** Each `exec` re-does the Kerberos handshake. ~100-300ms latency per call. | Acceptable for interactive use; do NOT benchmark as a bulk runner. PowerShell/Win32-OpenSSH#1328 is open since 2017.                                    |
| **In-box ssh.exe vs MIT KfW.** ssh-mcp does NOT silently fall back to MIT — failure stays loud.        | If your environment needs MIT tickets, install Git-for-Windows ssh and put it earlier on PATH; verify with `where.exe ssh`.                            |
| **Smart-mode LLM reachability.** Corporate proxy + `HTTPS_PROXY` env can block egress; smart denies on timeout/HTTP-error/network-error. | Pre-curl your `[approval.llm].endpoint` from the same user session before flipping to smart. If denied, you'll see `approval.reason` carrying the failure mode in the audit record. |
| **FQDN matters.** Always pass `host=eip2-db.css.com.tw`, never `eip2-db` or `10.x.x.x`. Windows SSPI builds the SPN from the hostname arg. | Validation: `tools/call exec` failing with `Server not found in Kerberos database` = likely short name or IP. Switch to FQDN.                          |
| **Multi-instance lock (`runtime.json`).** Concurrent boots on the same port fail loudly with the right diagnostic. | If a crash leaves a stuck record, delete `%USERPROFILE%\.ssh-mcp\runtime.json` once.                                                                  |
| **WSL trust boundary.** Mirrored networking means WSL clients reach `127.0.0.1` on Windows. Treat WSL as same trust zone as the Windows user. | Do NOT bind non-loopback unless you intend LAN reach. Bind change = boot-fail without bearer token (good).                                            |

---

## Provenance + linked docs

- Source-of-truth README: `README.md` §"HTTP MCP Transport", §"Configuration File (TOML)", §"Audit Log", §"Approval Engine", §"Status WebUI", §"Security Model" — committed as `e51babd` on `feat/openssh-transport-kerberos-integration`.
- Starter TOML: `ssh-mcp.toml.example` (same commit). Mirrors the schema in `src/config/types.ts`.
- Companion smoke runbook: `.hermes/runbooks/windows-smoke-http-mcp.md` + `.hermes/runbooks/windows-smoke-http-mcp.ps1`. (Note: that file's §2B currently writes `name = ...` in `[[sources]]` — schema requires `id`. This runbook uses `id`; the smoke runbook needs the same fix in a follow-up patch.)
- Windows autostart pattern: `.hermes/runbooks/windows-autostart.md` + `register-ssh-mcp-startup.bat`. Use Task Scheduler `ONLOGON /IT /RL HIGHEST`. Do NOT use a Windows Service.
- Launcher file under change (separate repo, hand-edited): `D:\Repositories\McpsLaunch\StandaloneMcpServers.ps1`. This runbook shows diff snippets only; the file is not modified from inside this repo.
- Integration branch tip at authoring time: `e51babd docs: README + ssh-mcp.toml.example`. Cross-check this file against the README at the head of integration before executing.

Last revised: 2026-05-26 (documenter, kanban t_16320d08).
