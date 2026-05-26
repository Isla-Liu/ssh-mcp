# R0 Research: ssh-mcp-kerberos vs dbhub TOML/status patterns
Task t_2b983502 · researcher · 2026-05-25

Evidence sourced by reading files directly under
`/home/islaliu/Repositories/{ssh-mcp-kerberos,dbhub}` — no modifications made.

## 1. ssh-mcp-kerberos current architecture map

Entry point: `src/index.ts` (559 lines)
- Two CLI modes parsed by `parseArgv()` + `collectSshJsonArgs()`:
  - (A) Multi-host: repeated `--ssh=<JSON>` (each JSON object requires `name`,
    `host`, `user`/`username`, `auth`∈{kerberos,key,password}).
    Parsed by `parseServerConfigJson()` (index.ts:55–101).
  - (B) Legacy single-host: `--host --user [--kerberos|--key|--password] ...`,
    plus `--port`, `--transport`, `--sudoPassword`, `--suPassword`,
    `--knownHostsFile`, `--strictHostKeyChecking`, `--gssapiDelegateCredentials`,
    `--timeout`, `--maxChars`, `--disableSudo`.
- Validation: `validateConfig()` (index.ts:137) rejects mixing modes and
  enforces transport/kerberos compatibility rules.
- Boot: `bootstrapRegistry()` registers each `ServerConfig` into
  `TransportRegistry` (`src/transports/registry.ts`).
- MCP server: `new McpServer({name:'SSH MCP Server', version:'2.1.0'})` over
  **stdio only** (`StdioServerTransport`). No HTTP transport, no WebUI.

Transport layer (`src/transports/`):
- `types.ts` — `ISshTransport`, `TransportConfig`, `ServerConfig`, `ExecResult`,
  `ExecOptions`, `ExecElevatedOptions`, `ErrorCategory`, `AuthMode`.
- `factory.ts` — picks ssh2 vs openssh by `cfg.transport`.
- `ssh2.ts` (415 lines) — mscdex/ssh2 persistent Client; suPassword PTY flow;
  sudo `-S` stdin path; `SSHConnectionManager` (legacy export).
- `openssh.ts` (457 lines) — spawns system `ssh` per command (no
  ControlMaster on Windows). Required for Kerberos (`gssapi-with-mic`).
- `registry.ts` (127 lines) — `TransportRegistry`: lazy init, dedup by name,
  serializes concurrent init, default = first registered.

Utilities: `src/utils/shell.ts` — `sanitizeCommand`, `sanitizePassword`,
`escapeCommandForShell`.

## 2. MCP tools currently exposed (index.ts:287–362)

| Tool | Args | Status surface |
|------|------|----------------|
| `exec` | `command`, `description?`, `connectionName?` | none — returns stdout/stderr/exitCode mapped via `resultToMcpContent()` |
| `sudo-exec` (skipped if `--disableSudo`) | `command`, `description?`, `connectionName?` | same |
| `list-servers` | `{}` | returns a text block per server: `name [transport=…, auth=…, connected|not yet connected]`. Powered by `TransportRegistry.list()` which checks `transports.has(name)` to derive `connected` boolean. |

ExecResult → MCP: timeout/auth/host_key/connect/transport categories raise
`McpError(InternalError)`. Non-zero exit + stderr also throws. Success path
optionally appends `[stderr]` block. **No persistence**, no audit history,
no per-execution id.

## 3. dbhub TOML / status patterns

### TOML schema
File: `src/types/config.ts` (114 lines) + example `dbhub.toml.example`.
```
TomlConfig = { sources: SourceConfig[]; tools?: ToolConfig[] }
SourceConfig extends ConnectionParams + SSHConfig {
  id: string                        // required, unique
  description?: string
  dsn?: string                      // OR individual params
  connection_timeout?: number
  query_timeout?: number
  init_script?: string
  lazy?: boolean
  search_path?: string
}
ToolConfig = ExecuteSqlToolConfig | SearchObjectsToolConfig | CustomToolConfig
  (each has `source` referencing SourceConfig.id)
```
Per-source SSH tunnel via inline `ssh_host/ssh_port/ssh_user/ssh_key/...` and
`ssh_proxy_jump`. Per-tool `readonly` and `max_rows` are in `[[tools]]`, NOT
in `[[sources]]`.

### Config search paths (`src/config/toml-loader.ts` `resolveTomlConfigPath`)
Priority high→low:
1. `--config=<path>` CLI flag (highest)
2. `./dbhub.toml` in CWD
No XDG / home-dir fallback. `~/` expansion is provided for inner string fields
via `expandHomeDir`.

### Validation behaviour
- Empty `sources` array → fatal error.
- Duplicate `id` → fatal error.
- Each tool's `source` must reference an existing source `id`.
- Duplicate `(tool.name, tool.source)` pairs blocked.
- Built-in tools (`execute_sql`, `search_objects`) cannot carry custom-tool
  fields (description/statement/parameters).
- Env interpolation: `${VAR}` resolved at load time (`interpolateEnvVars`).
- DSN parsed for type/password obfuscation; password redaction is built in.

### WebUI / HTTP status surface
- Boot in `src/server.ts:55`. When `--transport=http`, mounts an Express app
  on `host:port` with:
  - `GET /healthz` plain-text OK
  - `GET /api/sources` — list all sources (transformed via
    `transformSourceConfig`, **strips password/ssh credentials**, attaches
    `tools[]` per source from `getToolsForSource()`).
  - `GET /api/sources/:sourceId` — single source detail or 404.
  - `GET /api/requests[?source_id=…]` — recent tracked MCP tool invocations
    from in-memory `RequestStore` (cap 100 per source, FIFO eviction). Record
    shape: `{id, timestamp, sourceId, toolName, sql, durationMs, client,
    success, error?}`.
  - `POST /mcp` — streamable MCP HTTP endpoint (stateless, JSON only; SSE
    rejected with 405).
  - `GET *` → SPA `index.html`. Static frontend served from compiled
    `public/`; Vite dev server suggested in dev mode.
- DNS-rebinding guard: `validateOrigin()` middleware on every request when
  browser sends `Origin`; reflected CORS only for validated origins.
- Hot-reload: `startConfigWatcher()` re-parses TOML on change (500ms debounce)
  and rolls back to last-good config on parse error.
- OpenAPI: `src/api/openapi.yaml` documents the REST surface
  (`DataSource`, `SSHTunnel`, `Tool`, `Error` schemas).

## 4. Patterns to reuse vs avoid

Reuse:
- `[[sources]]` array-of-tables shape with required `id` and optional
  `description` — already mirrored by planner's TOML sketch.
- `--config=<path>` precedence + CWD fallback (and add XDG/home fallback that
  dbhub lacks, since ssh-mcp is per-user CLI).
- `${ENV_VAR}` interpolation at load time, fatal on missing required env.
- Duplicate-id and tool-source cross-reference validation.
- `RequestStore`-style bounded in-memory rolling buffer for the WebUI
  "Recent Executions" panel (audit JSONL is durable; RequestStore is just the
  live view).
- `transformSourceConfig` pattern — return-shape factory that **strips
  secrets** before serialising to JSON. Apply same to ssh-mcp `password`,
  `sudoPassword`, `suPassword`, `keyPath`, `privateKey`, `auth_token`.
- DNS-rebinding origin guard for any non-loopback bind.
- Hot-reload watcher with debounce + rollback on validation failure (helpful
  for the manual-approval mode where mis-configuration locks out exec).

Do NOT directly port:
- HTTP transport for MCP itself. ssh-mcp's threat model is *interactive
  shell access*, not read-only SQL. Keeping MCP on **stdio only** keeps the
  blast radius confined to the Claude/Cursor parent process. The WebUI
  should be a *side channel* for status + approval, never an alternate
  inbound MCP endpoint.
- `[[tools]]` polymorphism. ssh-mcp's tool surface is fixed (exec /
  sudo-exec / list-servers). Per-source override goes in
  `[[sources].approval]` instead of inventing tool-level config.
- Single-server-per-config-file assumption. ssh-mcp already supports
  multiple `--ssh=<JSON>` entries; the TOML must preserve that and let CLI
  override TOML per the planner's precedence chain.
- The DSN field. There is no SSH analogue — `auth ∈ {kerberos,key,password}`
  + connection scalars is clearer than parsing pseudo-URLs.
- `--readonly` / `--max-rows`. SSH commands cannot be machine-validated for
  read-only-ness; the approval engine (yolo/smart/manual) is the right
  control here.

## 5. Existing test layout

`test/` (vitest, ESM, `cross-env SSH_MCP_DISABLE_MAIN=1`):
- `description.test.ts` — MCP arg sanitisation
- `maxChars.test.ts` — sanitizeCommand limits
- `openssh.unit.test.ts` — OpenSshTransport unit tests
- `persistent-connection.test.ts` — ssh2 lifetime
- `result-mapper.test.ts` — `resultToMcpContent`
- `smoke.ssh.test.ts` — boots `execSshCommand` against a real ssh server
  (`SSH_HOST`/`SSH_PORT`/`SSH_USER`/`SSH_PASSWORD` env)
- `sudo-exec.test.ts` — sudo flow
- `zod.compat.test.ts` — zod 3.23 schema lock

Commands (package.json): `npm test`, `npm run test:watch`, `npm run coverage`.
No integration test harness for testcontainers yet — planner already
flagged `e2e-smoke` (t_5d02508b) as a new task.

## 6. Security-sensitive ambiguities (planner/reviewer attention)

1. **Audit redaction completeness.** Plan's regex sweep covers
   `password|token|secret|key` and PEM/JWT/cloud-key shapes. **Risk**: command
   bodies often contain inline credentials in non-obvious shapes
   (`mysql -p<pass>`, `curl -u user:pass`, `kinit user@REALM` immediately
   followed by typed password on stdin). Redactor MUST also scrub stdout
   when commands like `cat /etc/shadow`, `kubectl get secret -o yaml`,
   `aws sts get-session-token` succeed.

2. **`env:NAME` resolution timing.** Plan says resolved at TOML load. **Risk**:
   secrets land in the resolved in-memory config and could leak via the
   `/api/sources` endpoint unless `transformSourceConfig`-style stripping is
   applied uniformly. Reviewer should require a deny-list test that
   `auth_token`, `password`, `sudo_password`, `key_path` never appear in API
   responses.

3. **WebUI bind default.** Plan says `127.0.0.1` default and token required
   for non-loopback. **Risk**: WSL / containers commonly bind 0.0.0.0 by
   accident. Boot-time check should reject non-loopback bind when
   `auth_token` is empty/missing — fail hard, do not warn.

4. **Manual mode without WebUI.** Plan correctly says fatal boot error.
   **Add**: also fatal when WebUI is enabled but listening on stdio-only
   (i.e., no HTTP listener started). Otherwise approvals queue forever.

5. **Smart-mode LLM exfiltration.** The LLM client POSTs `command`,
   `description`, and `profile.description` (which may include hints about
   target host purpose). **Risk**: leaks operational intent to a third-party
   API. Mitigation options reviewer should weigh: (a) require explicit
   opt-in env `SSHMCP_ALLOW_LLM_EGRESS=1`; (b) support self-hosted endpoint
   only by default; (c) redact host/user from the prompt.

6. **Approval bypass via legacy CLI.** When the operator uses
   `--ssh=<JSON>` without TOML, the global `[approval]` section is absent →
   default mode? Planner says default `manual` for safety. **Risk**: this
   silently breaks existing scripted invocations. Recommend: legacy CLI
   without TOML keeps `yolo` (current behaviour); TOML presence flips
   default to `manual`. Document this in `docs-examples`.

7. **Race between audit append and process kill.** ssh-mcp catches
   SIGINT/SIGTERM; audit store must `fsync` on each append or use a
   write-ahead approach, otherwise denials/allows can be lost in crash
   scenarios — important because the audit log is the *only* artifact for
   the manual-mode reviewer.

8. **Static UI XSS surface.** Plan says vanilla single-page UI. Pending
   approvals render `command`, `description`, `profile.description` — all
   user-controlled. Must escape (textContent, not innerHTML); reviewer to
   add a snapshot or DOM test.

## 7. Proposed ssh-mcp TOML schema sketch (refined from planner draft)

```toml
[server]
audit_dir = "~/.ssh-mcp"
audit_max_bytes = 10000
audit_rotate_size = "10MB"        # NEW: explicit instead of magic constant
audit_rotate_keep = 10            # NEW

[webui]
enabled = false                   # default off
host = "127.0.0.1"
port = 8088
auth_token = "env:SSHMCP_WEBUI_TOKEN"  # required when host != 127.0.0.1
manual_timeout_ms = 300000         # NEW: surface the 5-min default

[approval]
mode = "manual"                   # "yolo" | "smart" | "manual"
fail_closed = true

[approval.llm]
provider = "openai"               # NEW (planner risks#1): "openai" | "anthropic" | "azure"
endpoint = "https://api.openai.com/v1/chat/completions"
api_key  = "env:OPENAI_API_KEY"
model    = "gpt-4o-mini"
timeout_ms = 8000
allow_egress = false              # NEW (security#5): must be true to send any prompt

[[sources]]
id          = "prod-bastion"
description = "Production jump host."
host        = "bastion.example.com"
port        = 22
user        = "aduser@EXAMPLE.INTERNAL"
auth        = "kerberos"
default     = true
gssapi_delegate_credentials = "no"   # mirror existing CLI flag

[sources.approval]                # per-source override
mode = "yolo"
```

## 8. Recommended WebUI / status contract

REST (Express, off by default, loopback unless `auth_token` set):
- `GET /healthz` → `200 OK` plain text.
- `GET /api/profiles` →
  `[{id, host, user, port, auth, transport, connected, isDefault,
     approval_mode_effective, description}]`
  (mirror of `TransportRegistry.list()` plus TOML metadata; never includes
  password / key material).
- `GET /api/executions?profile=&limit=&since=` → tail of audit JSONL
  reconstituted as JSON array; stdout/stderr already capped at
  `audit_max_bytes` with `truncated` flag.
- `GET /api/approvals` → pending manual approvals
  `[{id, profile_id, tool, command, description, queued_at}]`.
- `POST /api/approvals/:id/allow` body `{note?: string}` → resolves promise.
- `POST /api/approvals/:id/deny` body `{note?: string}` → resolves promise.
- `GET /events` (SSE) → push `pending-approval` / `execution` events. Token
  carried as `?token=` query because EventSource cannot set headers.

Auth: every `/api/*` and `/events` requires `Authorization: Bearer <token>`
(or `?token=` for SSE) when configured. Loopback-only bind exempts the
Authorization header but still requires it if `auth_token` is set.

Origin guard: dbhub-style `validateOrigin()` for browser callers.

Frontend: single static HTML + minimal JS (no build step). Three panels:
Profiles, Recent Executions, Pending Approvals. All user-controlled strings
rendered via `textContent`.

## 9. Risks and unknowns surfaced for downstream tasks

- **Unknown**: whether `[approval.llm].provider` switching is required for v1
  or deferrable. Planner accepts deferral; reviewer should confirm.
- **Unknown**: ordering of audit append vs approval decision when smart mode
  errors. Recommendation: append `approval.decision='deny', reason='smart-error'`
  *before* the McpError is raised so the audit trail is consistent.
- **Unknown**: whether `--ssh=<JSON>` invocations should be auto-promoted to
  the TOML schema in-memory (so the approval engine and audit always see a
  uniform `ResolvedSource`). Recommendation: yes — single internal model
  reduces approval/audit special-casing.
- **Risk**: ssh-mcp currently uses `SSH_MCP_DISABLE_MAIN=1` env to gate the
  CLI side-effects under test. New WebUI must obey the same gate or tests
  will accidentally bind ports.
- **Risk**: hot-reload of TOML across credential rotations may evict
  in-flight pending approvals. Recommendation: re-key pending approvals by
  `profile.id`; if id is removed by reload, deny with `reason='profile removed
  during reload'`.

## Architecture map (one-paragraph summary)

`src/index.ts` parses CLI (legacy or `--ssh=<JSON>` repeatable), validates,
builds `ServerConfig[]`, registers them lazily in `TransportRegistry`
(`src/transports/registry.ts`). Each `connectionName` resolves to one of
`ssh2.ts` or `openssh.ts` transport (interfaces in `transports/types.ts`).
MCP server (`McpServer` from `@modelcontextprotocol/sdk`) exposes `exec`,
`sudo-exec`, `list-servers` over `StdioServerTransport`. No HTTP, no
persistence, no approval gate, no audit. Tests live in `test/` (vitest)
behind `SSH_MCP_DISABLE_MAIN=1`. The planner's epic
(`.hermes/plans/2026-05-25_ssh-mcp-toml-audit-approvals-webui.md`) adds
`src/config/`, `src/audit/`, `src/approval/`, `src/webui/` alongside the
existing transport layer.
