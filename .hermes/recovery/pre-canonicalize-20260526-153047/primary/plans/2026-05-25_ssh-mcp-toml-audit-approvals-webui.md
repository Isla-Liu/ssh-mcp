# ssh-mcp-kerberos: TOML config + audit log + approval engine + WebUI status

> Planner artifact for kanban task t_b94988d2. Execution is handed to
> developer-general via sub-tasks; this plan is the contract.

## Goal

Add four cross-cutting capabilities to ssh-mcp-kerberos while preserving
the existing `--ssh=<JSON>` and legacy single-host CLI exactly:

1. First-class TOML multi-profile configuration (dbhub-shaped).
2. Persistent command audit log under `~/.ssh-mcp/` (Windows: `%USERPROFILE%/.ssh-mcp/`).
3. Approval engine with three modes: `yolo`, `smart` (LLM-judged), `manual` (WebUI gate).
4. dbhub-style WebUI/HTTP status surface exposing profiles, connection state, recent
   executions, approval mode, smart decisions, and pending manual approvals (with
   approve/deny actions in manual mode).

## Architecture (high level)

```
src/
  index.ts                            (boot: CLI -> ConfigResolver -> Registry + Pipeline + WebUI)
  config/
    types.ts                          TOML schema (TS interfaces)
    toml-loader.ts                    parse + validate + path expand + redact in logs
    resolver.ts                       precedence: CLI > TOML > legacy --ssh > env
    __tests__/toml-loader.test.ts
    __tests__/resolver.test.ts
  audit/
    types.ts                          AuditRecord shape
    redactor.ts                       password/secret scrubbing (case + key list + regex)
    store.ts                          JSONL appender, bounded output (truncate>N bytes)
    rotator.ts                        size/day rotation (default 10MB x 10 files)
    __tests__/redactor.test.ts
    __tests__/store.test.ts
  approval/
    types.ts                          ApprovalMode, ApprovalDecision, PendingApproval
    engine.ts                         dispatch by mode; fail-closed on smart errors
    yolo.ts                           returns ALLOW
    smart.ts                          LLM client (configurable endpoint/key/model)
    manual.ts                         enqueues PendingApproval; awaits WebUI signal
    __tests__/engine.test.ts
    __tests__/smart.test.ts
    __tests__/manual.test.ts
  webui/
    server.ts                         express HTTP server (off by default)
    routes/profiles.ts                GET /api/profiles
    routes/executions.ts              GET /api/executions (audit tail)
    routes/approvals.ts               GET /api/approvals, POST /api/approvals/:id/{allow,deny}
    routes/sse.ts                     SSE stream for pending approvals + new executions
    static/                           single-page status UI (vanilla, no build step)
    __tests__/routes.test.ts
  transports/                         (unchanged surface; receives ApprovalDecision before exec)
  tools/
    exec.ts                           wraps existing exec with audit + approval
    sudo-exec.ts                      same
```

Pipeline applied inside the MCP tool handlers (no change to transport interface):

```
tool call -> sanitize -> approval.engine.decide(profile, command, description)
                                      |
                                      v
                              ALLOW -> transport.exec -> audit.store.append(record)
                              DENY  -> McpError + audit.store.append(record with denied=true)
```

## TOML schema (mirrors dbhub structure)

```toml
# Top-level (optional)
[server]
audit_dir = "~/.ssh-mcp"            # default
audit_max_bytes = 10000             # per-line stdout/stderr cap; default 10000

[webui]
enabled = true                      # default false; CLI --webui to opt in
host = "127.0.0.1"
port = 8088
auth_token = "env:SSHMCP_WEBUI_TOKEN"  # required when host != 127.0.0.1

[approval]
mode = "smart"                      # "yolo" | "smart" | "manual"; default "manual"
fail_closed = true                  # smart errors -> deny; default true

[approval.llm]
endpoint = "https://api.openai.com/v1/chat/completions"
api_key  = "env:OPENAI_API_KEY"
model    = "gpt-4o-mini"
timeout_ms = 8000

[[sources]]
id          = "prod-bastion"
description = "Production jump host. Allowed: read-only diagnostics."
host        = "bastion.example.com"
port        = 22
user        = "aduser@EXAMPLE.INTERNAL"
auth        = "kerberos"            # "kerberos" | "key" | "password"
default     = true

[[sources]]
id          = "lab"
description = "Lab box for experiments."
host        = "lab.internal"
user        = "root"
auth        = "key"
key_path    = "~/.ssh/lab_ed25519"
sudo_password = "env:LAB_SUDO_PASS"

# Optional per-source approval override
[sources.approval]
mode = "yolo"
```

Precedence (high -> low):
1. CLI flags (legacy `--host`/`--user` or repeated `--ssh=<JSON>`)
2. `--config=<path>` TOML
3. `SSH_MCP_CONFIG=<path>` env -> TOML
4. `$XDG_CONFIG_HOME/ssh-mcp/config.toml` or `~/.ssh-mcp/config.toml`

`env:NAME` strings are resolved at load time. Missing env -> validation error.
Passwords NEVER appear in audit, logs, or WebUI responses (`redactor` enforces).

## Audit log

- Path: `<audit_dir>/executions-YYYYMMDD.jsonl` (one line per execution).
- Schema:
  ```json
  {
    "ts": "2026-05-25T12:34:56.789Z",
    "id": "01J...ulid",
    "profile": "prod-bastion",
    "tool": "exec" | "sudo-exec",
    "command": "...",                  // post-sanitize, post-redact
    "description": "...",              // verbatim from MCP arg
    "approval": {
      "mode": "smart",
      "decision": "allow" | "deny",
      "reason": "...",                 // LLM rationale or manual user note
      "decided_at": "...",
      "decided_by": "smart-llm" | "webui:user@host" | "yolo"
    },
    "exec": {                          // omitted if denied
      "exit_code": 0,
      "duration_ms": 132,
      "stdout_truncated": false,
      "stderr_truncated": false,
      "stdout": "...",                 // capped to audit_max_bytes
      "stderr": "..."
    }
  }
  ```
- Redaction rules (run in order on `command`, `description`, `stdout`, `stderr`):
  1. Drop any TOML value whose key matches `/password|token|secret|key/i`.
  2. Replace `--password=<val>`, `-p <val>`, `sudo -S` stdin patterns with `<redacted>`.
  3. Regex sweep: PEM blocks, AWS/Azure/GCP key shapes, JWT.
- Rotation: when current file > 10MB, rename with suffix `.1`, shift older files,
  keep last 10. Day boundary also rolls.

## Approval engine

```ts
type ApprovalDecision =
  | { decision: 'allow'; reason: string; decided_by: string }
  | { decision: 'deny';  reason: string; decided_by: string };

interface ApprovalContext {
  profile: ResolvedSource;          // includes TOML `description`
  tool: 'exec' | 'sudo-exec';
  command: string;                  // sanitized
  description?: string;             // from MCP arg
}

interface ApprovalEngine {
  decide(ctx: ApprovalContext): Promise<ApprovalDecision>;
}
```

- `yolo`: always allow.
- `smart`: POST to `approval.llm.endpoint` with a structured prompt asking the
  model to answer `{allow: bool, reason: string}` JSON. Prompt includes:
  profile description, command, command description. Any non-200, malformed
  JSON, or timeout -> `fail_closed=true` returns deny; else allow with a
  loud warning. Tests use a stub fetch.
- `manual`: push a `PendingApproval` into an in-process queue keyed by id,
  resolve via WebUI POST. Time-out (default 5 min) -> deny with reason
  `"approval timed out"`. If WebUI is disabled, manual mode startup is a fatal
  config error.

## WebUI

- Off by default. Enabled when `[webui].enabled = true` or `--webui` CLI flag.
- Listens on `127.0.0.1` by default; binding to non-loopback REQUIRES
  `auth_token`. Token checked via `Authorization: Bearer <token>` header for
  every `/api/*` route AND as a `?token=` query for SSE.
- Routes:
  - `GET /api/profiles` -> `[{id, host, user, auth, transport, connected, default, approval_mode_effective}]`
  - `GET /api/executions?profile=&limit=` -> last N audit records (default 100, max 1000)
  - `GET /api/approvals` -> pending manual approvals
  - `POST /api/approvals/:id/allow` body: `{note?: string}`
  - `POST /api/approvals/:id/deny`  body: `{note?: string}`
  - `GET /events` (SSE) -> push `pending-approval` and `execution` events
- Static UI under `/`: single page that polls `/api/profiles` + subscribes to
  `/events`. Three panels: Profiles, Recent Executions, Pending Approvals.

## Tasks (handed to developer-general)

The board fan-out below preserves order via parent->child links; each child
gets the EPIC id (`t_b94988d2`) as parent. Tests are mandatory per task.

1. **toml-config** — Implement `src/config/{types,toml-loader,resolver}.ts`
   plus tests. Adds `@iarna/toml` dep. Wire boot in `src/index.ts` so
   `--config=path` works alongside existing `--ssh`. Definition of done:
   `npm test` green; running with a sample TOML registers profiles
   identically to the equivalent `--ssh=<JSON>` invocation; legacy CLI
   unchanged when no TOML present.

2. **audit-log** — Implement `src/audit/*`, including `redactor`, `store`
   (JSONL append + rotation), and integration into the existing `exec` /
   `sudo-exec` tool handlers. Default audit dir `~/.ssh-mcp`, configurable
   via TOML `[server].audit_dir`. Definition of done: every successful and
   failed exec writes one JSONL line with redacted secrets; unit tests
   cover redactor rules + rotation; integration test asserts file content.

3. **approval-engine** — Implement `src/approval/{types,engine,yolo,smart,manual}.ts`
   with fail-closed semantics for `smart`. LLM client is a thin `fetch`
   wrapper; default to OpenAI chat-completions schema. Wire engine into
   the tool handlers BEFORE transport.exec, after audit prep. Definition
   of done: unit tests for all three modes (smart uses a stubbed fetch
   covering allow, deny, timeout, malformed JSON, non-200); engine refuses
   to start in manual mode if WebUI is disabled.

4. **webui-status** — Implement `src/webui/*` (express + SSE + static page),
   wired to `audit.store` (tail) and `approval.manual` (queue + resolve).
   Auth-token middleware required for non-loopback binds. Definition of
   done: integration test boots the server on an ephemeral port, hits
   each route, asserts pending-approval round-trip via POST resolves a
   manual decision. Static UI loads without a JS build step.

5. **e2e-smoke** — End-to-end smoke test that boots ssh-mcp with a sample
   TOML pointing at a `testcontainers` openssh box, executes `ls` via
   `exec` MCP tool in each approval mode, verifies audit JSONL + WebUI
   reflects the executions. Confirms no regression in existing
   `test/openssh.unit.test.ts` and `manual-multi-host-test.mjs`.

6. **docs-examples** — Update `README.md` with TOML section, audit dir
   layout, approval modes, WebUI screenshots-or-description, security
   guidance (fail-closed default, token requirement for non-loopback).
   Add `ssh-mcp.toml.example` at repo root. RUN AFTER reviewer PASS on
   tasks 1-5.

## Risks / open questions

- LLM provider lock-in: defaulting to OpenAI chat-completions JSON; smart.ts
  must be small enough to swap in Anthropic or Azure shapes without churn.
  Mitigation: provider field on `[approval.llm]` (string union), default
  `"openai"`; codepath is one fetch + one JSON parse.
- WebUI auth on shared hosts: loopback bind is the only safe default;
  documented requirement for token on non-loopback binds is enforced at
  boot, not best-effort.
- Manual approval timeout (5 min) may be too short for human operators
  switching contexts — surfaced as `[approval].manual_timeout_ms` later
  if users complain. Not in scope for v1.
- Audit log size on a chatty host: default 10MB x 10 files. Operators can
  override via TOML. Stdout/stderr per-record capped at `audit_max_bytes`
  (default 10000) with `truncated: true` flag.

## Verification matrix

| Capability | Test | Location |
|------------|------|----------|
| TOML parse + validate | unit | src/config/__tests__/ |
| Precedence (CLI > TOML > env) | unit | src/config/__tests__/resolver.test.ts |
| Redactor rules | unit | src/audit/__tests__/redactor.test.ts |
| JSONL append + rotation | unit | src/audit/__tests__/store.test.ts |
| Approval engine modes | unit | src/approval/__tests__/engine.test.ts |
| Smart LLM client (allow/deny/timeout/malformed) | unit (stub fetch) | src/approval/__tests__/smart.test.ts |
| Manual queue + resolve | unit | src/approval/__tests__/manual.test.ts |
| WebUI routes + SSE round-trip | integration | src/webui/__tests__/routes.test.ts |
| Existing openssh transport regression | unchanged | test/openssh.unit.test.ts |
| End-to-end (testcontainers) | integration | test/e2e.toml.test.ts |
