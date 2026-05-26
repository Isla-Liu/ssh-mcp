# Deployment on Windows (HTTP MCP transport)

> Stub authored alongside the HTTP MCP transport card. Full operator runbook
> ships with a separate docs card. This file pins the load-bearing decisions
> a future docs author must NOT undo.

## Why Task Scheduler ONLOGON /IT /RL HIGHEST

`ssh-mcp` calls Windows in-box `ssh.exe`, which uses SSPI/LSA for Kerberos
SSO. The LSA ticket cache lives inside the user's interactive logon session.
**Do NOT install ssh-mcp as a Windows Service** (e.g. via NSSM or sc.exe) —
LocalSystem and other service accounts cannot read the user's LSA cache,
so every GSSAPI handshake fails with `Server not found in Kerberos database`
or `No credentials cache found`.

Working pattern:

```powershell
# One-time setup
$action  = New-ScheduledTaskAction -Execute "node.exe" `
            -Argument "$env:USERPROFILE\ssh-mcp\build\index.js --transport-mcp=http --http-port=8934"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
            -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan)

Register-ScheduledTask -TaskName "ssh-mcp" -Action $action `
  -Trigger $trigger -Principal $principal -Settings $settings
```

Set the bearer token via the user's environment block (NOT in argv):

```powershell
[Environment]::SetEnvironmentVariable("SSH_MCP_HTTP_TOKEN", "<token>", "User")
```

## Port

Production default `8934`. Hyper-V's pre-existing
`_Mcp Servers Allow Wsl only` firewall rule already opens TCP 8931-8939 for
MCP servers; nothing else to configure when binding loopback.

## No MIT KfW fallback

This codepath does NOT try MIT `kinit` if Windows-side Kerberos is broken.
If your environment needs MIT tickets, switch `ssh.exe` via PATH (Cygwin or
Git-for-Windows ships a different `ssh` that consults the MIT KfW cache).
This is intentional — quietly forking into two SSO stacks at runtime hides
the failure mode from operators.

## Verify Kerberos availability

On boot with `authMode: 'kerberos'`, ssh-mcp runs `klist` (warn-only) to
confirm the user has a TGT. The server still boots so transient empty-cache
states are non-fatal; a follow-up `kinit`/relogon resolves it.

## Multi-instance race

ssh-mcp writes `%USERPROFILE%\.ssh-mcp\runtime.json` at boot with
`{pid, host, port, started_at, transport}`. A second instance trying to
bind the same port within 2 minutes — and finding the recorded PID still
alive — exits fatal. Stale records (PID gone, or >2 min old) are silently
overwritten.
