/**
 * End-to-end smoke for ssh-mcp-kerberos after TOML + audit + approval + WebUI +
 * HTTP-transport integration.
 *
 * Coverage:
 *   1. stdio transport: SDK Client ⇄ McpServer over InMemoryTransport.
 *      Exec stub returns exit 0; audit JSONL contains redacted record.
 *   2. http transport: real loopback listener with bearer; SDK
 *      StreamableHTTPClientTransport drives initialize → list → call.
 *      Audit JSONL contains redacted record; buildHttpAuditFields() contract
 *      surfaces transport=http and remote_addr (on non-loopback bind).
 *   3. Approval modes per http: yolo (allow), smart (stubbed LLM), manual
 *      (background resolver POSTs allow). Each path produces an audit row
 *      tagged with the right mode.
 *
 * Constraints:
 *   - No external SSH server. Tool handler uses a stub exec transport.
 *   - All listeners bind 127.0.0.1 on ephemeral ports (production reserves
 *     8934; the task notes 8939 — we use port=0 to avoid collisions).
 *   - Tests pass `skipRuntimeLock: true` so they don't trash any developer
 *     runtime.json on the host.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpListener } from '../../src/http-listener.js';
import { AuditStore } from '../../src/audit/store.js';
import { gateApproval, setApprovalEngine } from '../../src/approval/gate.js';
import { YoloApproval } from '../../src/approval/yolo.js';
import { SmartApproval } from '../../src/approval/smart.js';
import { ManualApproval } from '../../src/approval/manual.js';
import { buildHttpAuditFields, isLoopbackBind } from '../../src/audit/http-context.js';
import type { ApprovalDecision, ApprovalMode } from '../../src/approval/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Make a fake ISshTransport.exec/.execElevated pair returning fixed stdout. */
function fakeTransport(opts: { stdout: string; stderr?: string; exitCode?: number }) {
  const exec = async () => ({
    stdout: opts.stdout,
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  });
  return { exec, execElevated: exec };
}

/** Read all JSONL lines from a file as parsed records. */
function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Build an MCP server that exposes a single `exec` tool mirroring the real
 * handler shape: sanitize → gateApproval → run fake transport → audit.
 */
function buildMcpWithExec(opts: {
  store: AuditStore;
  profile?: string;
  transport: ReturnType<typeof fakeTransport>;
}) {
  const server = new McpServer({
    name: 'e2e', version: '0.0.0', capabilities: { resources: {}, tools: {} },
  });
  server.tool(
    'exec',
    'fake exec used by e2e smoke',
    {
      command: z.string(),
      description: z.string().optional(),
    },
    async ({ command, description }) => {
      const startedAt = Date.now();
      const decision: ApprovalDecision = await gateApproval({
        profile: { id: opts.profile ?? 'default' },
        tool: 'exec',
        command,
        description,
      });
      const result = await opts.transport.exec();
      opts.store.append({
        profile: opts.profile ?? 'default',
        tool: 'exec',
        command,
        description,
        approval: {
          mode: decision.mode,
          decision: decision.decision,
          reason: decision.reason,
          decided_at: decision.decided_at,
          decided_by: decision.decided_by,
        },
        exec: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      });
      return { content: [{ type: 'text' as const, text: result.stdout }] };
    },
  );
  return server;
}

function mkAuditTmp(): { dir: string; store: AuditStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-e2e-audit-'));
  return { dir, store: new AuditStore({ auditDir: dir, auditMaxBytes: 10_000 }) };
}

// ---------------------------------------------------------------------------
// 1. stdio transport smoke
// ---------------------------------------------------------------------------

describe('e2e smoke — stdio transport', () => {
  let tmpDir: string;

  afterEach(() => {
    setApprovalEngine(null);
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('exec call produces exit-0 result and writes a redacted audit record', async () => {
    const { dir, store } = mkAuditTmp();
    tmpDir = dir;
    setApprovalEngine(new YoloApproval());

    const server = buildMcpWithExec({
      store,
      transport: fakeTransport({ stdout: 'hello-stdio\n' }),
    });

    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientT);

    // Real command carries a secret to verify redaction.
    const res = await client.callTool({
      name: 'exec',
      arguments: { command: 'echo hi --password=hunter2', description: 'token=ghp_abcdefghijklmnopqrstuvwxyz01234567' },
    });
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('hello-stdio\n');

    const records = readJsonl(store.currentFilePath());
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r.tool).toBe('exec');
    expect(r.approval.mode).toBe('yolo');
    expect(r.approval.decision).toBe('allow');
    expect(r.command).toContain('--password=<redacted>');
    // ghp_ pattern redacted to <redacted> by redactor rule 8
    expect(r.description).toContain('<redacted>');
    expect(r.exec.exit_code).toBe(0);

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 2. http transport smoke + approval modes
// ---------------------------------------------------------------------------

describe('e2e smoke — http transport', () => {
  let handle: Awaited<ReturnType<typeof startHttpListener>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    setApprovalEngine(null);
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = undefined;
    }
  });

  async function spinHttp(server: McpServer): Promise<{
    handle: NonNullable<typeof handle>;
    client: Client;
  }> {
    handle = await startHttpListener(server, {
      bind: '127.0.0.1',
      port: 0,
      authTokenEnv: 'E2E_TOK',
      originAllowlist: ['http://127.0.0.1', 'http://localhost'],
      requestTimeoutMs: 10_000,
      skipRuntimeLock: true,
      env: { E2E_TOK: 'e2e-bearer' },
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: 'Bearer e2e-bearer',
          origin: 'http://127.0.0.1',
        },
      },
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return { handle, client };
  }

  it('initialize → list_tools → call(exec) with bearer; audit row written', async () => {
    const { dir, store } = mkAuditTmp();
    tmpDir = dir;
    setApprovalEngine(new YoloApproval());

    const server = buildMcpWithExec({
      store,
      transport: fakeTransport({ stdout: 'hello-http\n' }),
    });
    const { client } = await spinHttp(server);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('exec');

    const res = await client.callTool({
      name: 'exec',
      arguments: { command: 'whoami', description: 'token=ghp_abcdefghijklmnopqrstuvwxyz01234567' },
    });
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('hello-http\n');

    const records = readJsonl(store.currentFilePath());
    expect(records).toHaveLength(1);
    expect(records[0].approval.mode).toBe('yolo');
    expect(records[0].approval.decision).toBe('allow');
    expect(records[0].description).toContain('<redacted>');

    await client.close();
  });

  it('approval=smart (stubbed LLM allow) under http produces allow audit row', async () => {
    const { dir, store } = mkAuditTmp();
    tmpDir = dir;

    const smart = new SmartApproval({
      llm: { endpoint: 'https://stub.invalid/v1/chat', model: 'stub', timeout_ms: 1000 },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ allow: true, reason: 'stub allow' }) } }],
        }),
      }),
    });
    setApprovalEngine(smart);

    const server = buildMcpWithExec({
      store,
      transport: fakeTransport({ stdout: 'smart-ok\n' }),
    });
    const { client } = await spinHttp(server);

    const res = await client.callTool({ name: 'exec', arguments: { command: 'ls' } });
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('smart-ok\n');

    const records = readJsonl(store.currentFilePath());
    expect(records).toHaveLength(1);
    expect(records[0].approval.mode).toBe('smart');
    expect(records[0].approval.decision).toBe('allow');
    expect(records[0].approval.decided_by).toBe('smart-llm');
    expect(records[0].approval.reason).toBe('stub allow');

    await client.close();
  });

  it('approval=manual under http: background resolver allows → audit row mode=manual', async () => {
    const { dir, store } = mkAuditTmp();
    tmpDir = dir;

    const manual = new ManualApproval({ webuiEnabled: true, timeout_ms: 10_000 });
    setApprovalEngine(manual);

    const server = buildMcpWithExec({
      store,
      transport: fakeTransport({ stdout: 'manual-ok\n' }),
    });
    const { client } = await spinHttp(server);

    // Kick off the tool call, then poll for the pending entry and resolve allow.
    const inflight = client.callTool({ name: 'exec', arguments: { command: 'uptime' } });

    const deadline = Date.now() + 3000;
    let pending = manual.listPending();
    while (pending.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      pending = manual.listPending();
    }
    expect(pending.length).toBe(1);
    expect(manual.resolvePending(pending[0].id, 'allow', 'e2e operator', 'manual:e2e')).toBe(true);

    const res = await inflight;
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('manual-ok\n');

    const records = readJsonl(store.currentFilePath());
    expect(records).toHaveLength(1);
    expect(records[0].approval.mode).toBe('manual');
    expect(records[0].approval.decision).toBe('allow');
    expect(records[0].approval.decided_by).toBe('manual:e2e');

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP-context contract: transport=http + remote_addr surfacing
//
// The AuditRecord schema today does NOT include transport/remote_addr fields —
// the http-context module exports the shape contract, and the http-listener
// already tags requests with bindIsLoopback. The audit-tail wiring is deferred
// (parent task t_b4795825 documented this), but the contract itself MUST be
// stable so a future wiring card can flip the switch without breakage.
// ---------------------------------------------------------------------------

describe('e2e smoke — http-audit-fields contract', () => {
  it('buildHttpAuditFields: loopback bind omits remote_addr', () => {
    const req = { headers: { authorization: 'Bearer x' }, socket: { remoteAddress: '127.0.0.1' } } as any;
    const f = buildHttpAuditFields(req, /* bindIsLoopback */ true);
    expect(f.transport).toBe('http');
    expect(f.bearer_present).toBe(true);
    expect(f.remote_addr).toBeUndefined();
  });

  it('buildHttpAuditFields: non-loopback bind populates remote_addr', () => {
    const req = { headers: { authorization: 'Bearer x' }, socket: { remoteAddress: '10.1.2.3' } } as any;
    const f = buildHttpAuditFields(req, /* bindIsLoopback */ false);
    expect(f.transport).toBe('http');
    expect(f.remote_addr).toBe('10.1.2.3');
  });

  it('isLoopbackBind recognises canonical loopback hosts', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('localhost')).toBe(true);
    expect(isLoopbackBind('10.1.2.3')).toBe(false);
  });
});
