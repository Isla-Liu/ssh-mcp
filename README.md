# SSH MCP Server

[![NPM Version](https://img.shields.io/npm/v/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Downloads](https://img.shields.io/npm/dm/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Node Version](https://img.shields.io/node/v/ssh-mcp)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/tufantunc/ssh-mcp)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/tufantunc/ssh-mcp?style=social)](https://github.com/tufantunc/ssh-mcp/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tufantunc/ssh-mcp?style=social)](https://github.com/tufantunc/ssh-mcp/forks)
[![Build Status](https://github.com/tufantunc/ssh-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/tufantunc/ssh-mcp/actions)
[![GitHub issues](https://img.shields.io/github/issues/tufantunc/ssh-mcp)](https://github.com/tufantunc/ssh-mcp/issues)

[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/tufantunc/ssh-mcp)](https://archestra.ai/mcp-catalog/tufantunc__ssh-mcp)

**SSH MCP Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Kerberos / OpenSSH Transport](#kerberos--openssh-transport)
- [Configuration File (TOML)](#configuration-file-toml)
- [HTTP MCP Transport](#http-mcp-transport)
- [Audit Log](#audit-log)
- [Approval Engine](#approval-engine)
- [Status WebUI](#status-webui)
- [Security Model](#security-model)
- [Testing](#testing)
- [Disclaimer](#disclaimer)
- [Support](#support)

## Quick Start

- [Install](#installation) SSH MCP Server
- [Configure](#configuration) SSH MCP Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc)
- Execute remote shell commands on your Linux or Windows server via natural language

## Features

- MCP-compliant server exposing SSH capabilities
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- **Kerberos / GSSAPI single-sign-on** via the OpenSSH subprocess transport — opt-in; see [Kerberos / OpenSSH Transport](#kerberos--openssh-transport)
- **Multi-host registry** — register many SSH targets in a single ssh-mcp process via repeated `--ssh=<JSON>` or a TOML `[[sources]]` list; the `connectionName` argument picks which to run on
- **TOML configuration** — full config-file alternative to CLI flags, with `env:NAME` indirection for secrets and a documented precedence ladder; see [Configuration File (TOML)](#configuration-file-toml)
- **HTTP MCP transport (opt-in)** — Streamable HTTP listener on top of the MCP SDK, with bearer auth, DNS-rebinding protection, Origin allowlist, and a multi-instance race guard. Default transport remains stdio. See [HTTP MCP Transport](#http-mcp-transport)
- **Persistent audit log** — every `exec` / `sudo-exec` call is appended to a JSONL store, with secret redaction (passwords, tokens, PEM, JWT, GitHub PAT, AWS keys, Slack/Google), size-based rotation, and day-rolled retention. See [Audit Log](#audit-log)
- **Approval engine** — gate every call before it runs; modes `yolo` / `smart` (LLM judge, fail-closed) / `manual` (human-approves via the WebUI). See [Approval Engine](#approval-engine)
- **Status WebUI** — read-only browser surface for live profiles, recent executions, and the manual-approval queue. Loopback by default; bearer-token required for non-loopback. See [Status WebUI](#status-webui)
- Built with TypeScript and the official MCP SDK
- **Configurable timeout protection** with automatic process abortion
- **Graceful timeout handling** - attempts to kill hanging processes before closing connections

### Tools

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `command` (required): Shell command to execute on the remote SSH server
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Timeout Configuration:**

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `command` (required): Shell command to execute as root using sudo
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Notes:**
    - Requires `--sudoPassword` to be set for password-protected sudo
    - Can be disabled by passing the `--disableSudo` flag at startup if sudo access is not needed or not available
    - For persistent root access, consider using `--suPassword` instead which establishes a root shell
    - Tool will not be available at all if server is started with `--disableSudo`
  - **Timeout Configuration:**
    - Timeout is configured via command line argument `--timeout` (in milliseconds)
    - Default timeout: 60000ms (1 minute)
    - When a command times out, the server automatically attempts to abort the running process before closing the connection
  - **Max Command Length Configuration:**
    - Max command characters are configured via `--maxChars`
    - Default: `1000`
    - No-limit mode: set `--maxChars=none` or any `<= 0` value (e.g. `--maxChars=0`)

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tufantunc/ssh-mcp.git
   cd ssh-mcp
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, Claude Desktop to use this MCP Server.

**Required Parameters:**
- `host`: Hostname or IP of the Linux or Windows server
- `user`: SSH username

**Optional Parameters:**
- `port`: SSH port (default: 22)
- `password`: SSH password (or use `key` for key-based auth)
- `key`: Path to private SSH key
- `sudoPassword`: Password for sudo elevation (when executing commands with sudo)
- `suPassword`: Password for su elevation (when you need a persistent root shell)
- `timeout`: Command execution timeout in milliseconds (default: 60000ms = 1 minute)
- `maxChars`: Maximum allowed characters for the `command` input (default: 1000). Use `none` or `0` to disable the limit.
- `disableSudo`: Flag to disable the `sudo-exec` tool completely. Useful when sudo access is not needed or not available.
- `transport`: Transport implementation. `ssh2` (default, unchanged) or `openssh` (spawns the system `ssh` binary — needed for Kerberos). See [Kerberos / OpenSSH Transport](#kerberos--openssh-transport).
- `kerberos`: Flag shorthand for `--transport=openssh` with `GSSAPIAuthentication=yes`. Requires an active Kerberos ticket (TGT) on the client.
- `gssapiDelegateCredentials`: `yes` or `no` (default `no`). Forwards the client TGT to the remote host for second-hop SSO. Use only against trusted hosts.
- `knownHostsFile`: Path to a pinned `known_hosts` file (openssh transport only).
- `strictHostKeyChecking`: `yes`, `no`, or `accept-new` (default `accept-new`; openssh transport only).


```commandline
{
    "mcpServers": {
        "ssh-mcp": {
            "command": "npx",
            "args": [
                "ssh-mcp",
                "-y",
                "--",
                "--host=1.2.3.4",
                "--port=22",
                "--user=root",
                "--password=pass",
                "--key=path/to/key",
                "--timeout=30000",
                "--maxChars=none"
            ]
        }
    }
}
```

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
```

**Installation Examples:**

**With Password Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --port=22 --user=admin --password=your_password
```

**With SSH Key Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=example.com --user=root --key=/path/to/private/key
```

**With Custom Timeout and No Character Limit:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --user=admin --password=your_password --timeout=120000 --maxChars=none
```

**With Sudo and Su Support:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --user=admin --password=your_password --sudoPassword=sudo_pass --suPassword=root_pass
```

**Installation Scopes:**

You can specify the scope when adding the server:

- **Local scope** (default): For personal use in the current project
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope local -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```

- **Project scope**: Share with your team via `.mcp.json` file
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope project -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```

- **User scope**: Available across all your projects
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope user -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```


**Verify Installation:**

After adding the server, restart Claude Code and ask Cascade to execute a command:
```
"Can you run 'ls -la' on the remote server?"
```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

## Kerberos / OpenSSH Transport

> Experimental. Backwards-compatible: unchanged when `--transport` and `--kerberos` are both omitted.

The default `ssh2`-based transport does not implement GSSAPI/Kerberos authentication (upstream issue [mscdex/ssh2#333](https://github.com/mscdex/ssh2/issues/333), open since 2015). When an **opt-in** OpenSSH subprocess transport is selected, the server delegates SSH to the operating system's `ssh` binary, which supports:

- Kerberos SSO via GSSAPI (`-o GSSAPIAuthentication=yes`)
- Public-key auth (`-i <key>`)
- Password auth (via `SSH_ASKPASS`; not recommended — prefer Kerberos or keys)

### When to use it

- Windows client (domain-joined) → Linux target (AD-joined via SSSD/realmd, `sshd_config: GSSAPIAuthentication yes`): the user's logon TGT is consumed automatically by Win32-OpenSSH via SSPI. **No password. No key file.**
- Any environment where a Kerberos KDC issues tickets and SSH is preferred over re-entering credentials.

### Prerequisites

1. The `ssh` binary must be on `PATH` (Windows: enabled by default since Windows 10 1803; Linux: `apt install openssh-client`).
2. The **remote** `sshd_config` must have `GSSAPIAuthentication yes`.
3. The user must have a valid TGT:
   - **Windows (AD-joined):** automatic on login. Verify with `klist`.
   - **Linux (MIT Kerberos):** run `kinit <user@REALM>` or use `k5start` with a keytab for service accounts.
4. For an AD-integrated Linux target, SSSD/realmd must be joined to the domain.

### Example — Claude Code / any MCP client

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "-y", "ssh-mcp", "--",
        "--host=ubuntu-dev.example.internal",
        "--user=aduser@EXAMPLE.INTERNAL",
        "--kerberos"
      ]
    }
  }
}
```

Equivalent expanded form:

```bash
npx -y ssh-mcp -- \
  --transport=openssh \
  --host=ubuntu-dev.example.internal \
  --user=aduser@EXAMPLE.INTERNAL \
  --strictHostKeyChecking=accept-new
```

### CLI flags added by this mode

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--transport` | `ssh2` / `openssh` | `ssh2` | Selects implementation |
| `--kerberos` | flag | off | Implies `--transport=openssh` |
| `--gssapiDelegateCredentials` | `yes` / `no` | `no` | Forward TGT (trusted hosts only) |
| `--knownHostsFile` | path | `~/.ssh/known_hosts` | `openssh` only |
| `--strictHostKeyChecking` | `yes` / `no` / `accept-new` | `accept-new` | `openssh` only |

### Caveats and limitations

- **No connection multiplexing on Windows.** Win32-OpenSSH does not support `ControlMaster` ([issue #1328](https://github.com/PowerShell/Win32-OpenSSH/issues/1328)). Each `exec` call spawns a fresh `ssh.exe` and performs a full Kerberos AP-REQ round trip. Expect ~100–300 ms extra latency per invocation on Windows. Linux/macOS may work around this with user-provided `ssh_config` `ControlMaster` settings — the transport does not configure multiplexing itself.
- **Password mode via `SSH_ASKPASS`.** When `--password` is combined with `--transport=openssh`, the server writes a short-lived askpass helper to `%TEMP%/ssh-mcp-<pid>/` and exports the password through a per-process environment variable. The password never appears in `argv` but is briefly visible to same-user-session process inspection. Prefer Kerberos or key auth.
- **`--suPassword` over OpenSSH transport** is implemented via `ssh -tt` with a local expect-style state machine (random-nonce sentinel prompts). Works, but has more moving parts than the ssh2 path. Report issues with stderr output if you hit a regression.
- **Delegation (`GSSAPIDelegateCredentials=yes`)** is off by default. Enabling it forwards your TGT to the remote host, which can then impersonate you elsewhere — use only against fully trusted infrastructure. See Microsoft's guidance on Kerberos delegation.

## Configuration File (TOML)

> Optional. CLI flags (legacy single-host or `--ssh=<JSON>`) keep working unchanged. The TOML file lets you keep many sources, the audit / approval / WebUI / HTTP-transport blocks, and any `env:NAME` indirections in one place.

### Discovery and precedence

ssh-mcp walks the four candidate sources below in order. The first one found wins; lower entries are ignored.

| Priority | Source                                                              |
|---------:|---------------------------------------------------------------------|
| 1        | CLI flags (legacy single-host OR repeated `--ssh=<JSON>`)           |
| 2        | `--config=<path>` (explicit)                                        |
| 3        | `$SSH_MCP_CONFIG` (env-pinned path)                                 |
| 4        | `$XDG_CONFIG_HOME/ssh-mcp/config.toml` (or `~/.config/ssh-mcp/config.toml` when XDG unset) |
| 5        | `~/.ssh-mcp/config.toml`                                            |

Top-level sections (`[server]`, `[server.http]`, `[webui]`, `[approval]`) survive even when CLI sources are present. Only the `[[sources]]` list is suppressed by CLI sources — they don't merge, to avoid double-registration.

A starter file ships at the repo root: [`ssh-mcp.toml.example`](./ssh-mcp.toml.example) — copy it to one of the discovery paths and edit.

### Secret indirection — `env:NAME`

Anywhere the schema accepts a secret-bearing string (`password`, `sudo_password`, `su_password`, `auth_token`, `api_key`), you may write `env:NAME` to defer the value to a process environment variable. The string itself never lands on disk. A missing or empty referenced env var causes boot to fail with a redact-safe error (the variable NAME is logged, never the value).

```toml
[approval.llm]
api_key = "env:OPENAI_API_KEY"

[[sources]]
id       = "legacy-db"
host     = "db.internal"
user     = "deploy"
auth     = "password"
password = "env:LEGACY_DB_PASSWORD"
```

### Schema

```toml
[server]
audit_dir       = "~/.ssh-mcp"   # JSONL audit dir. Default: ~/.ssh-mcp
audit_max_bytes = 10000          # Per-record stdout/stderr cap (UTF-8). Default 10000.

[server.http]                    # See "HTTP MCP Transport" below.
enabled            = false
bind               = "127.0.0.1"
port               = 8934
auth_token_env     = "SSH_MCP_HTTP_TOKEN"
origin_allowlist   = ["http://127.0.0.1", "http://localhost"]
allowed_hosts      = []          # Optional. Default derived from bind+port.
request_timeout_ms = 60000

[webui]
enabled    = false
host       = "127.0.0.1"
port       = 8088
auth_token = "env:SSHMCP_WEBUI_TOKEN"   # REQUIRED when host != loopback.

[approval]
mode        = "manual"           # yolo | smart | manual
fail_closed = true               # smart mode: deny on LLM error/timeout

[approval.llm]                   # Only consulted when mode = "smart".
endpoint   = "https://api.openai.com/v1/chat/completions"
api_key    = "env:OPENAI_API_KEY"
model      = "gpt-4o-mini"
timeout_ms = 8000
# provider = "openai"            # Reserved.

[[sources]]
id          = "prod-bastion"
description = "Production jump host."   # Surfaced to the smart-mode LLM.
host        = "bastion.example.com"
port        = 22                        # Default 22.
user        = "aduser@EXAMPLE.INTERNAL"
auth        = "kerberos"                # kerberos | key | password
default     = true                      # At most one source may be default.
# kerberos-only knobs:
gssapi_delegate_credentials = "no"      # yes | no. Default no.
strict_host_key_checking    = "accept-new"  # yes | no | accept-new
known_hosts_file            = "~/.ssh/known_hosts"

[sources.approval]
mode = "manual"                  # Per-source override of [approval].mode.

[[sources]]
id            = "lab"
host          = "lab.internal"
user          = "root"
auth          = "key"
key_path      = "~/.ssh/lab_ed25519"
# private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\n..."   # alt to key_path.
sudo_password = "env:LAB_SUDO_PASS"
# su_password = "env:LAB_SU_PASS"
# transport   = "openssh"        # ssh2 | openssh. Default: ssh2 (kerberos forces openssh).
```

Per-source `[sources.approval]` overrides win over the top-level `[approval].mode` for that one source. Boot validation catches unknown enum values, missing-required fields, duplicate source ids, and multiple `default=true`.

## HTTP MCP Transport

> Off by default. ssh-mcp ships as a stdio server (one MCP client per ssh-mcp process). The HTTP transport is opt-in and serves multiple MCP clients from a single ssh-mcp process.

When enabled, ssh-mcp serves the Streamable HTTP MCP protocol on `POST / GET / DELETE /mcp` and a `GET /healthz` probe (no auth) on the same listener.

### Selecting the transport (stdio vs http)

| Scenario                                                                 | Pick    | Why                                                                                                                                  |
|--------------------------------------------------------------------------|---------|--------------------------------------------------------------------------------------------------------------------------------------|
| Single MCP client per host (Claude Desktop, Claude Code, Cursor, etc.)   | `stdio` | One process per client, lifecycle managed by the client. Default. Nothing new to learn.                                              |
| Many MCP clients share one ssh-mcp instance                              | `http`  | One ssh-mcp serves them all; SSH connection registry is reused across requests via the stateful `Mcp-Session-Id`.                    |
| Need to reach ssh-mcp from a different host / VM / WSL distro            | `http`  | stdio cannot cross process boundaries. HTTP binds a TCP port you can route to. Always pair non-loopback bind with a bearer token.    |
| Production multi-host setup with audit, approval queue, WebUI            | `http`  | Long-lived ssh-mcp process accumulates queue state and audit context worth keeping warm.                                             |

### Enabling HTTP

CLI (overrides TOML, useful for one-shot smoke tests):

```bash
node build/index.js \
  --transport-mcp=http \
  --http-bind=127.0.0.1 \
  --http-port=8934 \
  --http-token-env=SSH_MCP_HTTP_TOKEN \
  --config=~/.ssh-mcp/config.toml
```

TOML (recommended for autostart):

```toml
[server.http]
enabled            = true
bind               = "127.0.0.1"
port               = 8934
auth_token_env     = "SSH_MCP_HTTP_TOKEN"
origin_allowlist   = ["http://127.0.0.1", "http://localhost"]
request_timeout_ms = 60000
```

Then set the bearer in the process environment (NOT in argv, NOT in the TOML):

```bash
# Linux / macOS / WSL
export SSH_MCP_HTTP_TOKEN="$(openssl rand -base64 36)"
node build/index.js  # transport=http if TOML enables it
```

```powershell
# Windows (per-user env so Task Scheduler inherits it)
[Environment]::SetEnvironmentVariable('SSH_MCP_HTTP_TOKEN', '<token>', 'User')
```

`auth_token_env` holds the env var **NAME**, never the value. The token itself is only ever read from `process.env`.

### `[server.http]` — full field reference

| Field                | Type    | Default                                       | Notes                                                                                                                        |
|----------------------|---------|-----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `enabled`            | boolean | `false`                                       | Set true (or pass `--transport-mcp=http`) to activate.                                                                       |
| `bind`               | string  | `"127.0.0.1"`                                 | Listen address. Non-loopback REQUIRES `process.env[auth_token_env]` to be a non-empty string, or boot fails (`fail-closed`). |
| `port`               | int     | `8934`                                        | TCP port. `0` (allowed via CLI only) means ephemeral, used in tests.                                                         |
| `auth_token_env`     | string  | `"SSH_MCP_HTTP_TOKEN"`                        | NAME of the env var holding the bearer. The value is constant-time-compared.                                                 |
| `origin_allowlist`   | string[]| `["http://127.0.0.1", "http://localhost"]`    | Allowed `Origin` headers. Both the SDK and a defense-in-depth listener check enforce.                                        |
| `allowed_hosts`      | string[]| derived (`127.0.0.1:port`, `localhost:port`, `[::1]:port`, plus bind:port if non-loopback) | Required input to the SDK's DNS-rebinding protection. The SDK only honours this list when DNS-rebinding protection is on (it is, always). |
| `request_timeout_ms` | int     | `60000`                                       | Per-request socket timeout. Cuts off hung clients without leaking sockets.                                                   |

### Boot-time fail-closed invariants

ssh-mcp throws BEFORE `listen()` on:

- **Non-loopback bind without a token.** Bound `0.0.0.0` (or anything not in 127.0.0.1 / ::1 / localhost) but `process.env[auth_token_env]` is empty or unset → fatal. The error names the bind and the env var, never the value.
- **Multi-instance race.** On boot, ssh-mcp writes `~/.ssh-mcp/runtime.json` (Windows: `%USERPROFILE%\.ssh-mcp\runtime.json`) with `{pid, host, port, started_at, transport}`. A second instance that finds a fresh record (< 2 min old) + the recorded PID still alive + the same port → fatal. Stale records (PID gone, or > 2 min old) are overwritten silently. If you ever need to break a stuck lock manually, delete `runtime.json`.

Loopback bind with no token is allowed (the boot logs `anonymous loopback (WARN)`), so first-run experimentation stays painless. Production should always set the token.

### MCP handshake over HTTP

Standard MCP handshake — `initialize` → `tools/list` → `tools/call(...)`. Sessions are stateful via the `Mcp-Session-Id` response header returned on `initialize`; carry that header on subsequent calls to reuse the warmed-up SSH connection registry.

```bash
curl -sS -X POST http://127.0.0.1:8934/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

The unauthenticated `GET /healthz` probe returns `200 {"status":"ok"}` — wire that into your orchestrator's liveness check.

### Windows-host smoke and autostart runbooks

Two operational runbooks live under [`.hermes/runbooks/`](./.hermes/runbooks/):

- `windows-smoke-http-mcp.md` + `.ps1` — end-to-end three-call MCP handshake against a running listener, with checklist. Both Flow A (mcp-proxy bridge — current prod) and Flow B (in-process HTTP — this transport) are covered.
- `windows-autostart.md` + `register-ssh-mcp-startup.bat` / `unregister-...bat` — Task Scheduler `ONLOGON /IT /RL HIGHEST` recipe. Do NOT install as a Windows Service — LocalSystem has no LSA cache, every Kerberos auth fails.

## Audit Log

Every `exec` and `sudo-exec` call writes exactly one JSONL line to the configured audit directory, AFTER the call resolves (success, transport failure, or approval-engine deny — denies still produce an audit record so policy refusals are auditable).

### Paths

| OS              | Default                                       | Override                  |
|-----------------|-----------------------------------------------|---------------------------|
| Linux / macOS   | `~/.ssh-mcp/executions-YYYYMMDD.jsonl`        | `[server].audit_dir` or env `SSH_MCP_AUDIT_DIR` |
| Windows         | `%USERPROFILE%\.ssh-mcp\executions-YYYYMMDD.jsonl` | same                       |
| WSL             | `$HOME/.ssh-mcp/executions-YYYYMMDD.jsonl`    | same                       |

The directory is `mkdir -p`'d on first append. Leading `~` and `~/` in `audit_dir` are expanded against the user's home directory.

### File format and rotation

- One UTF-8 JSON object per line, newline-terminated. No header, no schema row.
- File name pattern: `executions-YYYYMMDD.jsonl` (UTC date stamp). A fresh day naturally lands in a new file.
- **Size rotation:** when the active file exceeds `maxFileBytes` (default 10 MB) on the next append, it is renamed to `<file>.1`, the previous `.1` to `.2`, and so on up to `retain` (default 10). The oldest beyond `retain` is dropped.
- **Day rotation / pruning:** day-rolled files older than `retain` days are pruned on the first append of each new UTC day.

### Record shape

```json
{
  "ts": "2026-05-26T10:34:00.123Z",
  "id": "lq3k7n9zx-a1b2c3d4",
  "profile": "prod-bastion",
  "tool": "exec",
  "command": "psql -U postgres -c 'select count(*) from users'",
  "description": "user-supplied intent string, redacted",
  "approval": {
    "mode": "manual",
    "decision": "allow",
    "reason": "approved by ops at 10:33Z",
    "decided_at": "2026-05-26T10:33:59.700Z",
    "decided_by": "manual:webui"
  },
  "exec": {
    "exit_code": 0,
    "duration_ms": 142,
    "stdout_truncated": false,
    "stderr_truncated": false,
    "stdout": "  count\n-------\n  10234\n(1 row)\n",
    "stderr": ""
  }
}
```

`exec` is omitted on a denied call (`approval.decision === "deny"`) — the command never reached the transport.

### Secret redaction

`command`, `description`, `stdout`, and `stderr` are run through the redactor BEFORE serialization. Patterns matched (over-aggressive on purpose):

- CLI long flags: `--password=...`, `--token=...`, `--secret=...`, `--api-key=...`, `--access-key=...`, `--client-secret=...`, `--auth-token=...`, `--bearer=...` (with `=`, space, or quoted-value forms)
- CLI short: MySQL-style `-p ...`
- HTTP headers: `Authorization: Bearer <token>`, `Authorization: Basic <b64>`
- Shell env: `MY_PASSWORD=...`, `*TOKEN=...`, `*SECRET=...`, `*APIKEY=...`, `*PRIVATE_KEY=...`, `*CLIENT_SECRET=...`
- JSON / TOML key-value: `"password": "..."`, `password = "..."`, dotted variants
- Human prose: `password hunter2`, `token abc`
- PEM blocks (`BEGIN/END PRIVATE KEY`)
- AWS access-key-id (AKIA/ASIA), AWS secret-access-key on-the-same-line, JWTs, GitHub PATs (`ghp_…`), Slack tokens, Google API keys (`AIza…`)

False positives — your real output picking up `<redacted>` — are intentional. Credentials in the audit log are a P0 incident; false redactions are a UX paper cut. **Passwords are never logged**, even when supplied via `--password=...` or `[[sources]].password = "..."`.

## Approval Engine

Every `exec` / `sudo-exec` call passes through a gate BEFORE the transport runs the command. A deny throws `McpError(InvalidRequest)`; the call never reaches the remote and is still recorded in the audit log (`approval.decision = "deny"`, no `exec` block).

| Mode     | Behavior                                                                                                                                         | Suitable for                                                                                  |
|----------|--------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `yolo`   | Allow everything. Decision still lands in the audit log (`decided_by="yolo"`).                                                                   | Lab boxes, sandboxes, scripted batch jobs you've already vetted.                              |
| `smart`  | Ask the LLM at `[approval.llm]` for a `{"allow":bool,"reason":string}` JSON verdict. **Fail-closed by default** (deny on timeout / HTTP error / malformed response). | Production hosts where a human can't be in the loop for every call but you want a sanity check. |
| `manual` | Enqueue a `PendingApproval`, wait up to 5 minutes for a human to allow or deny via the WebUI. **Boot fails if `[webui].enabled = false`** — there's no other resolver. | Critical production hosts; ops-on-call workflow.                                              |

### Per-source override

A `[sources.approval]` block on a specific `[[sources]]` entry wins over the global `[approval].mode` for that one source. Mix `manual` on bastion hosts with `yolo` on a lab.

```toml
[approval]
mode = "manual"

[[sources]]
id = "prod-bastion"
# inherits manual

[[sources]]
id = "lab"
[sources.approval]
mode = "yolo"
```

### Smart-mode fail-closed semantics

When `[approval].fail_closed = true` (default), the smart engine returns `deny` on:

- HTTP non-200 response from the LLM endpoint
- Request timeout (default 8 s, override via `[approval.llm].timeout_ms`)
- Network error / DNS failure
- Malformed JSON in the response body or in the LLM's content payload
- Missing `allow` boolean in the LLM JSON

Setting `fail_closed = false` flips those failures to `allow` with a warning in the audit `reason`. **Do this only with eyes open** — a flaky LLM endpoint then becomes a security bypass. The default is the safe choice.

### Manual-mode timeout

A queued approval that nobody resolves within 5 minutes (default) resolves itself as `deny` with `reason: "approval timed out"`. Override per-deployment by extending the manual options (currently only exposed in code; the TOML schema for per-engine timeouts will follow when needed).

## Status WebUI

> Off by default. Required when `[approval].mode = "manual"` because the queue needs a UI to resolve from.

A read-only browser surface for live ssh-mcp state:

- `/api/profiles` — registered sources, each with current connection state and effective approval mode
- `/api/executions?profile=...&limit=...` — recent audit records (paginated; reads the JSONL store)
- `/api/approvals` — pending manual-approval queue
- `POST /api/approvals/:id { decision: "allow"|"deny", note?: string }` — resolve a queued approval
- `/events` — Server-Sent Events stream: live `enqueue` / `resolve` / `execution` events

### Enabling

```toml
[webui]
enabled    = true
host       = "127.0.0.1"   # loopback default
port       = 8088
# auth_token = "env:SSHMCP_WEBUI_TOKEN"   # REQUIRED when host != loopback
```

### Auth model

- **Loopback bind, no token** → allowed (convenient for single-user dev).
- **Loopback bind, token set** → token required on every `/api/*` request.
- **Non-loopback bind, no token** → boot fails (fail-closed; matches `[server.http]`).
- **Non-loopback bind, token set** → token required.

Tokens can be presented as `Authorization: Bearer <tok>`, header `X-Auth-Token: <tok>`, or — for the SSE endpoint only — query string `?token=<tok>` (because EventSource cannot set headers).

## Security Model

A compact summary of the safety properties this codebase tries to preserve. If any of these fail in practice, file an issue with a reproducer.

- **Passwords are never logged.** `--password`, `[[sources]].password`, `sudoPassword`, `suPassword` never appear in stdout, stderr, audit records, or `--ssh=<JSON>` echo paths. The audit redactor catches password-shaped patterns even when they leak through `command` or `stdout`.
- **Approval defaults to `manual`.** The `[approval]` block defaults to `mode = "manual"` and `fail_closed = true` in the shipped TOML example. Lab / sandbox deployments must opt in to `yolo` explicitly.
- **Fail-closed everywhere meaningful.** Non-loopback HTTP bind without a token refuses to boot. Smart approval mode denies on LLM failure. Manual mode denies on queue timeout. Boot-time errors are loud (process exits) rather than soft-warn (silent degrade).
- **Multi-instance lock.** A fresh `runtime.json` + live PID + same port refuses to start. Crashed-and-restarted is handled cleanly (stale records are overwritten). Concurrent boots on the same port produce one clear `EADDRINUSE`-equivalent message, not a confusing race.
- **DNS-rebinding protection on HTTP.** The SDK's `enableDnsRebindingProtection` is ALWAYS on (per the SDK design, it silently ignores `allowedHosts`/`allowedOrigins` otherwise). `Host` and `Origin` headers are checked at both the SDK and the listener layer.
- **No MIT Kerberos fallback on Windows.** When the in-box `ssh.exe` cannot find a usable LSA ticket, ssh-mcp does NOT silently switch to a Git-for-Windows ssh.exe / MIT KfW cache. Failure stays loud. See `.hermes/runbooks/windows-autostart.md`.
- **Run interactively on Windows, never as a service.** Windows Services run in session 0 under LocalSystem — no user TGT. Use the Task Scheduler `ONLOGON /IT /RL HIGHEST` recipe in `windows-autostart.md`.

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
npm run inspect
```

## Disclaimer

SSH MCP Server is provided under the [MIT License](./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](./CONTRIBUTING.md) for more information.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Support

If you find SSH MCP Server helpful, consider starring the repository or contributing! Pull requests and feedback are welcome. 