# R1: HTTP MCP transport + Windows Kerberos deployment research

Task: t_a3c8b5e1 (researcher). Read-only — no source modified.

## 1. Current startup is stdio-only (confirmed)

File: src/index.ts (559 lines)
- Imports only StdioServerTransport: line 7 `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`
- main() at lines 522–538 constructs `new StdioServerTransport()` (line 524) and `server.connect(transport)` (line 525). Logs "running on stdio" at 527. Cleanup via SIGINT/SIGTERM/exit hooks 535–537.
- Test-mode branch at lines 540–550 also wires stdio.
- McpServer instance declared at lines 278–282; three tools registered (exec 287, sudo-exec 312, list-servers 346).

Smallest patchable surface to add HTTP without breaking stdio
- Introduce a CLI flag, e.g. `--transport-mcp=stdio|http` (default stdio). Parsed alongside argvConfig at line 105.
- Replace the body of main() lines 522–538 with a switch: when http, mount a StreamableHTTPServerTransport behind a small Node http listener and call `server.connect(httpTransport)` from inside the request handler (stateless) or once at boot (stateful with sessionId). When stdio, keep existing path.
- Surface area: ~30 LOC added in src/index.ts plus one new src/http-listener.ts (recommend). No change to registry, transports, or tools — the McpServer object is transport-agnostic.

## 2. SDK exposes StreamableHTTPServerTransport (current API)

Pinned: package.json line 22 `"@modelcontextprotocol/sdk": "^1.17.5"`.
Installed in node_modules: `@modelcontextprotocol/sdk` version 1.29.0 (verified via node_modules/@modelcontextprotocol/sdk/package.json).

Import path (Node):
```
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
```
Source: node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js line 48 `export class StreamableHTTPServerTransport`. It is a thin wrapper around WebStandardStreamableHTTPServerTransport (line 10 import) and exposes `handleRequest(req, res, parsedBody?)` (line 128), `start()`, `close()`, `send()`, `closeSSEStream()`, `closeStandaloneSSEStream()`.

Constructor options (verified in webStandardStreamableHttp.js lines 60–70):
- `sessionIdGenerator?: () => string` — undefined = stateless single-shot, defined = stateful with Mcp-Session-Id
- `enableJsonResponse?: boolean` (default false → SSE)
- `onsessioninitialized?: (sid)=>void`
- `allowedHosts?: string[]`            ← DNS-rebinding guard (Host header)
- `allowedOrigins?: string[]`          ← CORS-style Origin guard
- `enableDnsRebindingProtection?: boolean` (default false; must be set true to activate the two lists above) — verified line 109 `if (!this._enableDnsRebindingProtection) return;` short-circuits validation when off.

Minimal research-only startup snippet (do NOT commit; for reference only):
```ts
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),           // stateful; use `undefined` for stateless
  enableJsonResponse: false,                        // keep SSE for server-pushed notifications
  enableDnsRebindingProtection: true,
  allowedHosts: ['127.0.0.1:39998', 'localhost:39998'],
  allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
});
await server.connect(transport);

const listener = http.createServer((req, res) => {
  // bearer-token gate BEFORE delegating; close early on miss
  if ((req.headers.authorization ?? '') !== `Bearer ${process.env.SSH_MCP_HTTP_TOKEN}`) {
    res.writeHead(401).end('unauthorized'); return;
  }
  transport.handleRequest(req, res);
});
listener.listen(39998, '127.0.0.1');
```

## 3. Recommended HTTP mount / guards / auth

- Mount path: `POST /mcp` (and `GET /mcp` for SSE pull). MCP spec convention; the transport itself does not pin a path, you route to it from your http server.
- Bind: 127.0.0.1 only. With WSL2 mirrored networking (your env memory confirms unified loopback) this is reachable from WSL Hermes Agent without exposing to LAN.
- DNS-rebinding guard: pass `enableDnsRebindingProtection: true` AND `allowedHosts: ['127.0.0.1:<port>','localhost:<port>']`. Without the flag, allowedHosts is ignored (verified line 109).
- Origin guard: `allowedOrigins: ['http://127.0.0.1','http://localhost']` — MCP clients from WSL won't send Origin; browser attackers will. Reject mismatched Origin.
- Auth: bearer token (env `SSH_MCP_HTTP_TOKEN`) in `Authorization` header — middleware BEFORE `handleRequest`. mTLS is overkill on loopback and adds Windows cert-store hassle; revisit only if binding is widened.
- Disable CORS preflight reflection unless you intentionally serve a browser UI — keep `Access-Control-Allow-Origin` unset by default.
- Session id: stateful mode lets you reuse Kerberos-bound ssh connections across calls; stateless re-auths every call which on Kerberos means a fresh GSSAPI handshake per exec — measurable latency. Recommend STATEFUL (sessionIdGenerator: randomUUID).

## 4. ssh2 npm + Kerberos on Windows (RED for ssh2 path; GREEN for openssh path)

- ssh2 (mscdex) does NOT implement GSSAPI/Kerberos. Confirmed by:
  - Grep of node_modules/ssh2/lib: zero matches for "gssapi" or "kerberos".
  - Existing repo comment src/transports/openssh.ts line 19: "the mscdex/ssh2 library does not implement GSSAPI/Kerberos" — that's why the openssh transport exists.
- The project already routes kerberos auth through OpenSSH transport (src/transports/openssh.ts lines 153–157):
  ```
  '-o', 'GSSAPIAuthentication=yes',
  '-o', 'GSSAPIDelegateCredentials=...',
  '-o', 'PreferredAuthentications=gssapi-with-mic',
  ```
- On Windows the spawned `ssh` is Microsoft's in-box Win32-OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`). It is hard-linked to **SSPI** at compile time (StackOverflow #75470070, answer by grawity) — it does NOT load MIT KfW GSSAPI64.DLL. Practical consequence:
  - SSPI uses the Windows LSA ticket cache populated by domain login (Active Directory).
  - `kinit`-populated MIT ticket caches (`FILE:C:\Users\<u>\krb5cc_...`) are NOT visible to in-box ssh.exe.
  - To use MIT tickets you must point to a different ssh.exe (Cygwin/MSYS/Git-for-Windows) — out of scope for default deployment.

## 5. Node-on-Windows Kerberos quirks (deployment notes)

- SPN format: `host/<fqdn>@<REALM>`. Windows SSPI builds the SPN automatically from the hostname you pass to ssh — you must use the **FQDN**, not a short name or IP. Mismatch → "Server not found in Kerberos database" (already classified as 'auth' at src/transports/openssh.ts line 448).
- Ticket cache: in-box ssh.exe + SSPI uses the **LSA cache**; user must be domain-joined OR have run `cmdkey /add:*.domain /user:... /pass` to seed SSPI. `klist` from a normal cmd shows the cache.
- Delegation: requires the service ticket to have OK-AS-DELEGATE and the user/host marked "Trusted for delegation" in AD. ssh client flag is `-o GSSAPIDelegateCredentials=yes` — already plumbed via cfg.gssapiDelegateCredentials.
- Fallback: if no ticket present, the in-box ssh.exe will silently fail GSSAPI then fall through to next PreferredAuthentications method — but the current code pins `PreferredAuthentications=gssapi-with-mic` (line 157), so it will FAIL hard instead of falling back to password. **YELLOW**: an explicit `auth=kerberos` ServerConfig will not opportunistically fall back. Document this as expected, or relax PreferredAuthentications to `gssapi-with-mic,password,publickey` when password/keyPath also provided.
- The ssh process must run **as the interactive user**, not as LocalSystem — LSA tickets are per-session. Affects autostart (see §8).

## 6. Approval-engine LLM endpoint + corporate proxy

Recommended env var convention (mirrors dbhub):
- `SSH_MCP_APPROVAL_LLM_URL` — full endpoint URL (e.g. `https://api.openai.com/v1/chat/completions`).
- `SSH_MCP_APPROVAL_LLM_API_KEY` — bearer key.
- `SSH_MCP_APPROVAL_LLM_MODEL` — model id.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` — standard Node-honored vars (Node 24 honors them when using `fetch` with `dispatcher`; on Node < 21 use `undici.ProxyAgent` or `global-agent`). Document that on Windows the proxy is often set per-user under `winhttp` — agents must pass it as env on launch, not rely on `netsh winhttp set proxy`.
- Add `SSH_MCP_APPROVAL_LLM_CA_BUNDLE` — corporate MITM proxies often inject a custom root; map to `NODE_EXTRA_CA_CERTS` at launch.
- Health check before tool registration: ping the LLM endpoint with a 5-second timeout when boot mode is `manual` AND fail_closed; fatal if unreachable so the operator sees the problem immediately rather than at first tool call.

## 7. Risks (labelled)

- RED — Secret leakage via audit. If the audit log captures full request bodies, command strings can contain passwords (`echo 'secret' | sudo -S ...`) and key material. Sanitizer must redact `--password`, `--sudoPassword`, `--suPassword`, `password:`-prefixed JSON, and ENV var assignments containing the substring `PASS`/`TOKEN`/`KEY`. Existing sanitizePassword (src/utils/shell.ts referenced from index.ts line 15) is the right hook — extend, don't reinvent.
- RED — Multi-instance race. WSL2 mirrored networking means 127.0.0.1:<port> is the same socket on Windows host AND WSL. If a second ssh-mcp is started inside WSL on the same port, only one will bind (EADDRINUSE), but if they pick different ports the WSL agent could be misrouted to a stale WSL-side process. Mitigation: at boot, write `%USERPROFILE%\.ssh-mcp\runtime.json` with `{pid,host,port,started_at}`; refuse start if file is fresh (<2 min) and pid alive. Also document that the canonical instance is Windows-host-only.
- YELLOW — Loopback mirroring + WebUI binding. If WebUI binds to 127.0.0.1 on Windows host it is visible from WSL automatically (mirrored loopback). That is the intended behavior but it surprises operators expecting WSL isolation. Document explicitly. If the WebUI runs without auth_token (manual mode allows that today), any WSL process can call it — RED in shared-tenancy WSL setups, but Isla's setup is single-user → YELLOW.
- YELLOW — DNS rebinding. Without `enableDnsRebindingProtection: true`, a malicious page in a browser opened on the Windows host could re-resolve a domain to 127.0.0.1 and POST to /mcp. Setting allowedHosts/Origins + bearer token closes this.
- YELLOW — Stateless mode + Kerberos. Re-handshaking GSSAPI per request adds 50–200ms; not lethal but argues for stateful sessions and a per-server ssh-connection cache (already present in registry/openssh transports).
- GREEN — Transport selection. SDK 1.29 ships StreamableHTTPServerTransport with stable API; no migration risk in current pin range (^1.17.5).
- GREEN — ssh2 Kerberos path. Routed through openssh transport which is the only viable mechanism on Windows; no regression.

## 8. Recommended deployment topology + autostart

Topology
- ssh-mcp.exe on Windows host, bound 127.0.0.1:<port> (e.g. 39998), bearer-token gated, stateful StreamableHTTP.
- WSL Hermes Agent calls `http://127.0.0.1:39998/mcp` with `Authorization: Bearer ${SSH_MCP_HTTP_TOKEN}`. Mirrored networking gives this for free; no need for vEthernet (WSL) IP.
- WebUI (if enabled) on a separate port 127.0.0.1:<webui_port> with auth_token; reachable from both Windows browser and WSL curl.
- One canonical instance: Windows host. Document that WSL must NEVER spawn its own ssh-mcp; the Hermes mcp_servers entry should be HTTP client only.

Autostart pattern on Windows
- **Recommended: Task Scheduler with "At log on" trigger, interactive session.** This keeps the LSA ticket cache alive for SSPI Kerberos. Service-account (LocalSystem) installs WILL break Kerberos because LSA tickets are per-logon-session.
- Concrete:
  - schtasks /Create /SC ONLOGON /RL HIGHEST /TN "ssh-mcp" /TR "powershell -WindowStyle Hidden -File C:\path\to\ssh-mcp-launcher.ps1" /IT
  - Launcher PS sets env (SSH_MCP_HTTP_TOKEN, HTTPS_PROXY, NODE_EXTRA_CA_CERTS), then `node C:\path\ssh-mcp\build\index.js --transport-mcp=http --port=39998 --ssh=<JSON>...`
- Alternative: Startup folder shortcut — simpler, equally Kerberos-friendly. Avoid sc.exe / nssm wrapping as a Windows Service — those run as LocalSystem by default and lose user Kerberos context.
- Health probe: same launcher PS does `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:39998/healthz -Headers @{Authorization=...}` after 3s sleep and writes a log; on failure pops a toast.

## Deliverable summary

- Stdio-only entry point confirmed at src/index.ts:524.
- SDK 1.29.0 (installed under ^1.17.5 pin) exposes StreamableHTTPServerTransport at `@modelcontextprotocol/sdk/server/streamableHttp.js` with options for DNS-rebinding & Origin guards + sessioned/stateless modes.
- Kerberos must continue to flow through the existing OpenSshTransport because ssh2 npm has no GSSAPI support. On Windows the in-box ssh.exe uses SSPI/LSA cache (NOT MIT KfW) — autostart must run interactive, not as a service.
- Bearer-token + loopback bind + DNS-rebinding flags is the right defense-in-depth; mTLS unnecessary on mirrored loopback.
- Biggest open risks: multi-instance race (RED), audit-log secret leakage (RED) — both mitigable in toml-config + audit-log child tasks.
