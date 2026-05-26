# Windows autostart for ssh-mcp — Task Scheduler (interactive logon)

> Audience: a human at the Windows console.
> WSL agents cannot execute these helpers — they live on the Windows side.
> Companion runbook: `windows-smoke-http-mcp.md` (verifies a running instance).
> Source research: `.hermes/research/2026-05-26_R1_http_transport_windows_kerberos.md` §8.

## TL;DR

```cmd
REM register at next logon (run from cmd or PowerShell on Windows host)
.\register-ssh-mcp-startup.bat

REM optional: trigger immediately without logging out
schtasks /Run /TN ssh-mcp

REM remove
.\unregister-ssh-mcp-startup.bat
```

## Why Task Scheduler ("At log on") — and not a Windows Service

The ssh-mcp Kerberos path on Windows works like this:

1. ssh-mcp spawns the in-box `C:\Windows\System32\OpenSSH\ssh.exe` for every SSH
   connection (the `OpenSshTransport` in `src/transports/openssh.ts`). The
   Node-side `ssh2` npm package has no GSSAPI/SSPI binding, so we deliberately
   shell out to `ssh.exe`.
2. `ssh.exe` calls into **SSPI**, which reads tickets from the **LSA cache**.
3. The LSA cache is **per logon session** — every interactive logon gets its
   own. A Windows Service runs in **session 0** under a service principal
   (LocalSystem or a dedicated service account) which has **no user TGT** and
   cannot acquire one without a stored keytab.

Therefore, if ssh-mcp runs as a Windows Service, every Kerberos auth attempt
hits "No Kerberos credentials available" and falls through to the next
PreferredAuthentication. The current code pins
`PreferredAuthentications=gssapi-with-mic` for kerberos-only ServerConfigs
(`src/transports/openssh.ts:153–157`), so it fails hard instead of degrading
silently — which is the correct behaviour, but means service-mode is unusable
for the production AD hosts.

**This is why deployment option (b) was rejected.** R1 §8 documents this in
full. Task Scheduler with the `/IT` flag is the only autostart mechanism that
keeps ssh-mcp inside your interactive logon and therefore inside your LSA
context.

> Concrete schtasks invocation (what `register-ssh-mcp-startup.bat` runs):
>
> ```
> schtasks /Create /SC ONLOGON /RL HIGHEST /TN ssh-mcp ^
>   /TR "cmd /c "<launcher.bat>"" /IT /F
> ```
>
> | Flag         | Why                                                                                  |
> | ------------ | ------------------------------------------------------------------------------------ |
> | `/SC ONLOGON`| Fires at every interactive logon. No fixed time — survives reboots and re-logons.    |
> | `/IT`        | **Critical.** Forces the task into the interactive session, not session 0.           |
> | `/RL HIGHEST`| Highest available privileges. Lets ssh-mcp bind privileged ports if you move off 8934. Does **not** elevate beyond what the registering user can do. |
> | `/F`         | Overwrite without prompting — makes the helper idempotent.                           |

## How to verify Kerberos works after first logon

After your first logon (or right after running the helper + logging out/in):

```cmd
klist
```

You should see entries for `krbtgt/<REALM>` and one service ticket per host
ssh-mcp has connected to (`host/<fqdn>@<REALM>`). On the production AD this
realm is `CSS.COM.TW`.

If `klist` shows an empty cache after a fresh logon:

```cmd
klist purge
```

…then log off and log back on. If that still produces an empty cache (rare —
usually means your domain account never logged on interactively on this box),
seed the credential store explicitly:

```cmd
cmdkey /add:* /user:CSS\<your-sam-account> /pass
```

The `/pass` flag will prompt for the password. This stores it under the
Credential Manager so SSPI can use it on the next ssh invocation.

To smoke-test ssh-mcp itself end-to-end after registration, follow
`.hermes/runbooks/windows-smoke-http-mcp.md` (the §1A/§1B start-server steps,
then §3 onward). The script `windows-smoke-http-mcp.ps1 -Flow Auto` will
auto-detect whether your Task Scheduler entry actually started a Flow A
(mcp-proxy bridge) or Flow B (in-process Streamable HTTP) listener.

## Coexistence rule — exactly one launcher

The Task Scheduler entry registered by these helpers must be the **only**
auto-start mechanism for ssh-mcp on this host. R1 flagged multi-instance race
as a **RED** risk: two launchers will fight for the same TCP port (8934 by
policy, whether you stay on the Flow A mcp-proxy bridge or move to Flow B
in-process HTTP), and whoever loses logs a confusing `EADDRINUSE` while the
winner serves stale state.

Things to remove if you are migrating *to* Task Scheduler from another method:

- Startup folder: `shell:startup` then delete any `StandaloneMcpServer*` /
  `ssh-mcp*` shortcut.
- HKCU `Run` key: `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  and delete entries pointing at the launcher.
- Old scheduled tasks under different names: `schtasks /Query /FO LIST | findstr ssh-mcp`.
- Any `sc.exe` / `nssm` service registration: `sc query | findstr -i ssh`.
  **If you find a service: remove it.** It is the failure mode this whole
  document exists to prevent.

## Troubleshooting

### "Task did not fire at logon"

Event Viewer → **Applications and Services Logs → Microsoft → Windows →
TaskScheduler → Operational**. Filter for the task name `ssh-mcp`. The two
events you care about:

- `106` — task registered (one-shot, at registration time).
- `129` — task process launched (one per logon; absence means the trigger
  didn't fire).
- `203` / `204` / `301` — failures. `203` typically means the `/TR` target
  doesn't exist or isn't executable in the user's context.

### "Task fires but ssh-mcp exits immediately"

Run the launcher from a normal `cmd` window in your interactive session
*first*, and watch the output. The Task Scheduler entry is just a fancy
wrapper around the same invocation — if the launcher fails interactively, it
will fail under the scheduler too.

### "Task fires but Kerberos still doesn't work"

Confirm `/IT` actually took effect:

```cmd
schtasks /Query /TN ssh-mcp /V /FO LIST | findstr /R /C:"Logon Mode" /C:"Run As User"
```

`Logon Mode` should read **Interactive only** or **Interactive/Background**,
not **Background only**. If it reads `Background only`, the registration
silently dropped `/IT` (almost always because the registering user is not the
same as the user whose logon will fire the task). Re-run the registration from
a session owned by the user who will be logging on.

### "I want to test the task without logging out"

```cmd
schtasks /Run /TN ssh-mcp
```

This fires the task in your current session immediately. Useful after edits to
`StandaloneMcpServer.bat` or after rebuilding ssh-mcp.

## Launcher overrides

By default the helper targets `%~dp0..\McpsLaunch\StandaloneMcpServer.bat`,
which resolves correctly when `register-ssh-mcp-startup.bat` lives in a
sibling directory of `McpsLaunch\` on Windows (e.g.
`D:\Repositories\ssh-mcp-launcher\register-ssh-mcp-startup.bat` next to
`D:\Repositories\McpsLaunch\StandaloneMcpServer.bat`).

If your layout is different, set `SSH_MCP_LAUNCHER` before running the helper:

```cmd
set SSH_MCP_LAUNCHER=D:\Repositories\McpsLaunch\StandaloneMcpServer.bat
.\register-ssh-mcp-startup.bat
```

The helper will use the env-var path verbatim and the recorded `/TR` value
inside the task will point at that absolute path.

## If you later want a service-mode instance on a non-Kerberos host

Service mode is a legitimate deployment for hosts where ssh-mcp connects only
via key-based or password auth — no Kerberos required. **It must be a
separate ssh-mcp instance on a separate port**, not a replacement for this
one. Concretely:

- Run `register-ssh-mcp-startup.bat` on the AD-joined host for Kerberos
  traffic (this document).
- On the non-Kerberos host, use `sc.exe create ...` or `nssm install ...` with
  a different `--port=<N>` and a config file that lists only the
  key/password-auth target hosts.
- The two instances must never share a port. The Hermes side picks which to
  use by URL.

Do not co-locate them on the same host: the service-mode instance has no LSA
ticket and will route Kerberos requests into the failure pit described at the
top of this document.

## Files in this directory

| File                                  | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `register-ssh-mcp-startup.bat`        | Register the Task Scheduler entry. Idempotent.              |
| `unregister-ssh-mcp-startup.bat`      | Remove the Task Scheduler entry. Idempotent.                |
| `windows-autostart.md`                | This document.                                              |
| `windows-smoke-http-mcp.md`           | End-to-end smoke runbook for a running instance.            |
| `windows-smoke-http-mcp.ps1`          | Auto-driver for the smoke runbook.                          |

## References

- R1 §5 — Kerberos / SSPI / LSA mechanics.
  `.hermes/research/2026-05-26_R1_http_transport_windows_kerberos.md`
- R1 §8 — Deployment topology + autostart recommendation.
- P2 plan §5 — "Windows autostart — DOCS ONLY (per task constraint)".
  `.hermes/plans/2026-05-26_P2_http-mcp-transport_windows-kerberos.md`
- Production launcher (current): `D:\Repositories\McpsLaunch\StandaloneMcpServer.bat`
  (which delegates to `StandaloneMcpServers.ps1`).
