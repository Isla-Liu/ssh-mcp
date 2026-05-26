# P2: HTTP MCP Transport + Windows Kerberos Integration — Design

> Authored by planner t_00777089. Consumes R1 (t_a3c8b5e1). Hands off to developer-general t_a60efb40.

Goal: add an opt-in Streamable HTTP MCP transport to ssh-mcp-kerberos while preserving stdio as the default, and pin down the Windows-host Kerberos deployment surface so Hermes (running in WSL) can reach the Windows-side LSA ticket cache without breaking SSPI semantics.

Architecture: in-process Streamable HTTP via @modelcontextprotocol/sdk's StreamableHTTPServerTransport, mounted on POST/GET /mcp on 127.0.0.1, bearer-token gated, with DNS-rebinding + Origin guards. Stdio path stays untouched and remains default. Kerberos continues to flow through the existing OpenSshTransport (src/transports/openssh.ts) because ssh2 npm has no GSSAPI; on Windows the spawned in-box ssh.exe uses SSPI/LSA, so the launcher must run in the user's interactive logon session (Task Scheduler /IT ONLOGON), not as a Windows Service.

Tech Stack: Node 22+, TypeScript, @modelcontextprotocol/sdk ^1.17.5 (installed 1.29.0), node:http, existing TOML loader from t_2d87e8fa.

---

## 0. Decision: Option B (in-process Streamable HTTP), NOT Option A (mcp-proxy bridge)

Background (per t_a60efb40 orchestrator comment): planner must pick A vs B.

Verdict: **Option B**.

Rationale:
- SDK 1.29 ships StreamableHTTPServerTransport with stable surface inside the ^1.17.5 pin (R1 §2). No new runtime dep.
- ssh-mcp must own its own bearer-token check, audit transport/remote_addr fields, DNS-rebinding & Origin guards, and approval/WebUI integration. A bridge (mcp-proxy.exe wrapping a stdio child) hides remote_addr from ssh-mcp and forces double-process supervision on Windows.
- Latency: stateful in-process StreamableHTTP keeps a single ssh-mcp instance with a warm ssh-connection registry; a bridge re-spawns or buffers stdio per session.
- Operationally simpler on Windows host: one Task Scheduler entry, one PID, one log directory, one auth token.

Trade-off accepted: ~80 LOC + tests of HTTP-listener code now live in this repo. That cost is bounded and reviewable.

## 1. Files to Add / Change

### Add
- `src/http-listener.ts` — node:http server wrapper around StreamableHTTPServerTransport. Owns: bearer middleware, fail-closed boot check for non-loopback bind, bind/port logging, healthz route.
- `src/audit/http-context.ts` — tiny helper that turns an IncomingMessage into `{transport:'http', remote_addr, sessionId}` for the existing audit logger.
- `test/unit/http-transport.test.ts` — vitest covering bearer, origin, rebinding, fatal-on-non-loopback-without-token, healthz.
- `test/integration/http-handshake.test.ts` — end-to-end initialize → tools/list → tools/call (exec stub) over real loopback HTTP using the SDK client.
- `test/unit/audit-transport-field.test.ts` — verifies audit row contains transport='http' and remote_addr when non-loopback, transport='stdio' otherwise.
- `docs/deployment-windows.md` — stub note (full content owned by docs card). Mention Task Scheduler ONLOGON /IT pattern, env file, LSA cache requirement.

### Modify
- `src/index.ts`
  - Lines 522–538 (`main()`): branch on `transportMcp === 'http'`; when http, call into `src/http-listener.ts` instead of constructing StdioServerTransport.
  - Lines 540–550 (test-mode bootstrap): leave stdio. HTTP path has its own tests via http-listener entry.
  - Lines 105–129 (argv parsing): add `argvConfig['transport-mcp']` and `argvConfig.port` (already exists but currently only used as SSH legacy `--port`; rename to `--http-port` to avoid collision — see §3).
  - Re-export `startHttpTransport` for tests.
- `src/config/toml.ts` (created in t_2d87e8fa) — add `[server.http]` schema; see §2.
- `src/audit/logger.ts` (or equivalent created in audit card) — accept optional `{transport, remote_addr, sessionId}` per call; default transport='stdio'.

### Do not touch
- `src/transports/*` — no change. McpServer is transport-agnostic; OpenSsh + ssh2 + factory + registry are untouched.
- WebUI binding — stays on its own port. Reachable from WSL via mirrored loopback automatically (R1 §7 YELLOW, accepted).

## 2. TOML Schema Delta

Add to the existing config schema (developer-general t_2d87e8fa's loader):

```toml
[server.http]
enabled            = false                      # bool, default false
bind               = "127.0.0.1"                # string
port               = 7022                       # int, 1024–65535
auth_token_env     = "SSH_MCP_HTTP_TOKEN"       # name of env var that holds the bearer
origin_allowlist   = ["http://localhost", "http://127.0.0.1"]
request_timeout_ms = 60000
```

Notes:
- Port default 7022 (per task constraint). R1 floated 39998; both are fine — task says 7022, plan honors task.
- `auth_token_env` is the NAME of the env var, never the value. The value is read at boot from `process.env[cfg.auth_token_env]`.
- Missing `auth_token_env` resolved to empty string is fatal **iff** `bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost'`. Loopback bind is allowed without token but emits WARN and writes `auth: 'none-loopback'` into audit records.
- `enabled=false` AND no `--transport-mcp=http` CLI flag → stdio (default behavior unchanged).
- CLI flag `--transport-mcp=http` overrides `[server.http].enabled=false`. CLI flag `--http-bind`, `--http-port`, `--http-token-env` override TOML fields. Resolution order: CLI > TOML > defaults.

## 3. CLI flag additions (in src/index.ts parseArgv)

- `--transport-mcp=stdio|http` (default `stdio`)
- `--http-bind=<ip>` (default from TOML or `127.0.0.1`)
- `--http-port=<int>` (default from TOML or `7022`)
- `--http-token-env=<NAME>` (default from TOML or `SSH_MCP_HTTP_TOKEN`)

Backward compat: existing `--port` continues to mean legacy single-host SSH port (current behavior at line 110). Do NOT reuse `--port` for HTTP.

## 4. Security posture

Implemented in `src/http-listener.ts` BEFORE delegating to `transport.handleRequest`:

1. **Bearer gate**: read `Authorization: Bearer <token>`. Compare in constant time to `process.env[cfg.auth_token_env]`. On miss, `401 unauthorized` and return without invoking transport. Skip ONLY when bind is loopback AND auth_token_env value is empty AND boot-mode opted in (`SSH_MCP_HTTP_ALLOW_ANONYMOUS_LOOPBACK=1`, defaults off — fail-closed).
2. **Boot-time fatal**: if `bind` resolves to non-loopback (not in `{127.0.0.1, ::1, localhost}`) AND token is empty, log RED and `process.exit(2)` before `listener.listen()`.
3. **DNS-rebinding guard**: pass `enableDnsRebindingProtection: true` plus `allowedHosts: ['<bind>:<port>', 'localhost:<port>']` and `allowedOrigins: cfg.origin_allowlist` to the StreamableHTTPServerTransport constructor. Confirmed by R1 §2 that `enableDnsRebindingProtection` must be true for `allowedHosts` to take effect (verified node_modules line 109).
4. **Origin enforcement**: SDK handles; we also reject requests with `Origin` header not in `origin_allowlist` at the listener layer for double-defense and to emit a clean audit record.
5. **Stateful session**: `sessionIdGenerator: () => crypto.randomUUID()` to keep warm ssh registry across calls (R1 §3 final paragraph).
6. **Secret redaction**: extend `sanitizePassword` (src/utils/shell.ts) to also strip `Authorization` headers from any logged request line. Audit logger NEVER receives the raw `req.headers`; only `{transport, remote_addr, sessionId}`.
7. **Bounded stdout/stderr**: already enforced by `MAX_CHARS` (index.ts:118–129). No change.
8. **Smart fail-closed**: if approval engine LLM endpoint unreachable on boot in manual mode, fatal (per R1 §6). Reused as-is; HTTP transport does not alter approval flow.

## 5. Kerberos / Windows path

No code change needed in `src/transports/openssh.ts`. R1 §4–5 confirm:
- ssh2 npm has no GSSAPI → keep routing Kerberos through OpenSshTransport.
- Windows in-box ssh.exe uses SSPI/LSA cache — no MIT KfW. The launcher MUST run in the user's interactive session.

Code-side action items (minimal):
- In `src/transports/openssh.ts:153–157`, **relax** `PreferredAuthentications=gssapi-with-mic` to `gssapi-with-mic,publickey,password` ONLY when the ServerConfig also supplies a fallback secret (keyPath/privateKey OR password). When kerberos-only, keep strict to fail fast with a recognizable error. Emit one INFO log line on startup naming the policy in effect.
- Add a startup self-test (warn-only) on Windows: if `process.platform === 'win32'` AND any ServerConfig has `auth: 'kerberos'`, spawn `klist` and parse output; if zero tickets, log YELLOW pointing at the docs runbook. Do NOT block startup.

YELLOW handoff for developer-general:
- We deliberately do NOT add a "fallback to MIT kinit" code path. If a user needs MIT tickets they must switch ssh.exe via PATH (Cygwin/Git-for-Windows). Document in `docs/deployment-windows.md` stub. If, during implementation, this turns out to bite the operator, file a follow-up card; do not stretch this one.

Windows autostart — DOCS ONLY (per task constraint):
- `docs/deployment-windows.md` stub names Task Scheduler ONLOGON /IT /RL HIGHEST as the supported pattern (R1 §8). Explicitly call out: do NOT install as Windows Service / LocalSystem (breaks Kerberos LSA).

## 6. Audit log delta

Extend the audit record schema (owned by audit card; coordinate via comment on t_a60efb40):
- Add columns/fields: `transport TEXT NOT NULL DEFAULT 'stdio'`, `remote_addr TEXT NULL`, `mcp_session_id TEXT NULL`.
- `transport` populated by caller; HTTP listener fills `'http'`, stdio path fills `'stdio'`.
- `remote_addr` only filled when `req.socket.remoteAddress` is not in `{'127.0.0.1','::1','::ffff:127.0.0.1'}` (avoid noise on the common case).
- Bearer token and Authorization header are NEVER written. Add an assertion in the audit writer (`if (record.headers?.authorization) throw`) to make this loud during tests.

## 7. Acceptance Criteria (parity with stdio)

A1. `npm test` passes with no new failures on stdio path (existing suite).
A2. With `[server.http].enabled=false` and no `--transport-mcp=http`, boot log says "running on stdio" (current behavior).
A3. With `--transport-mcp=http` alone on a loopback bind and no token, boot logs WARN "anonymous loopback" only if `SSH_MCP_HTTP_ALLOW_ANONYMOUS_LOOPBACK=1`, otherwise fatal.
A4. With `--transport-mcp=http --http-bind=0.0.0.0` and empty token env, boot exits non-zero with a RED log line naming the bind and the missing env var.
A5. With a valid token in `SSH_MCP_HTTP_TOKEN`, a real MCP client connects via `http://127.0.0.1:7022/mcp` and can run initialize → tools/list → tools/call(exec, payload).
A6. With token mismatch, server returns 401 and writes no audit row for that connection attempt other than a one-line "auth_failed" event.
A7. With a forged `Origin: http://evil.example` and valid token, request is rejected by the rebinding guard.
A8. With `Host: attacker.com:7022` header and valid token, request is rejected.
A9. Audit table rows include `transport='http'` and `remote_addr` populated when non-loopback; `transport='stdio'` and null `remote_addr` for stdio runs.
A10. Approval engine path unchanged: a tool call requiring approval still surfaces via WebUI (or fail-closed when WebUI off) regardless of transport.

## 8. Test Matrix

| # | Scenario | Expected |
| - | - | - |
| T1 | Default boot (no flags) | stdio transport; existing tests pass |
| T2 | `--transport-mcp=http` loopback + token | 200 on /mcp with bearer; 401 without |
| T3 | `--transport-mcp=http --http-bind=0.0.0.0`, no token | process.exit(2) before listen() |
| T4 | Forged Origin / Host header | SDK rebinding guard returns 403/400 |
| T5 | Audit row content | transport/remote_addr correct in both modes |
| T6 | Windows kerberos boot self-test (mocked klist returning 0 tickets) | WARN logged, server still boots |
| T7 | Stateful session reuse | Two sequential exec calls on same Mcp-Session-Id reuse warm ssh connection (assert single 'authenticated' log entry) |
| T8 | Token rotation | Restart with new env value invalidates old sessions (sessions are ephemeral in-memory; assert old session_id receives 401) |

Mock-friendly Kerberos verification (T6) uses a fake `child_process.spawn` returning canned `klist` output; no real AD required.

## 9. GREEN / YELLOW / RED

GREEN — proceed
- StreamableHTTPServerTransport API stability inside ^1.17.5 pin.
- OpenSsh transport already handles kerberos; no transport refactor needed.
- 127.0.0.1 bind + WSL mirrored loopback gives Hermes-in-WSL reach to Windows host for free.

YELLOW — implement with documented caveats
- WebUI auto-visible across mirrored loopback (single-user env, acceptable).
- PreferredAuthentications relaxation only when fallback creds supplied; pure kerberos config keeps strict failure.
- No MIT kinit fallback. Documented workaround: alternate ssh.exe in PATH.
- Stateful session memory footprint: cap at N=64 sessions, evict LRU; document.

RED — blockers (must be resolved during dev or escalated)
- Audit log secret leakage: the existing `sanitizePassword` must be extended to also redact `Authorization` headers and `Bearer …` substrings before any other audit writer ships. If audit card (t_…) merges first without this hook, file a follow-up before HTTP transport lands.
- Multi-instance race: Windows host + WSL both binding 127.0.0.1:7022. Mitigation: at boot write `%USERPROFILE%\.ssh-mcp\runtime.json` with `{pid, bind, port, started_at}`; if file is fresh (<120s) and PID alive, exit fatal with a clear message. Linux/WSL writes equivalent at `~/.ssh-mcp/runtime.json` — same logic.

## 10. Out of scope (file follow-up cards if surfaced)

- mTLS on the HTTP listener. Loopback + bearer is sufficient per R1 §3.
- Reverse proxy / HTTPS termination. Bind stays loopback; if remote access is later needed, add via tunneled SSH or an explicit proxy card.
- Windows-host installer / signed binary. Operator runs node directly via Task Scheduler.
- WebUI auth_token rotation flow.

---

## Handoff to developer-general (t_a60efb40)

Decision: Option B (in-process Streamable HTTP). The orchestrator's pre-comment can be resolved; the full original scope of t_a60efb40 stands.

Implementation order suggestion (do not hand-modify the child task body; this is guidance only):
1. Add TOML schema delta + tests (depends on t_2d87e8fa landing first).
2. Add `src/http-listener.ts` skeleton + bearer + non-loopback fatal + healthz + unit tests.
3. Wire into `src/index.ts main()` behind `--transport-mcp=http`.
4. Add DNS-rebinding/Origin allowlist + tests.
5. Extend audit writer with transport/remote_addr + tests.
6. Add Windows kerberos klist self-test (mocked) + relax PreferredAuthentications conditional.
7. Add integration test: real loopback HTTP roundtrip of initialize/list/exec.
8. Stub `docs/deployment-windows.md` — single paragraph + Task Scheduler one-liner.
9. End with `kanban_block(reason="review-required: http mcp transport + windows kerberos")` per task body.
