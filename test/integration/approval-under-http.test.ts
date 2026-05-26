/**
 * Integration: with HTTP transport active AND approval engine in manual mode,
 * a tool call enqueues a PendingApproval BEFORE transport.exec is invoked.
 *
 * The approval engine path is transport-agnostic by construction (the gate
 * sits inside the exec/sudo-exec tool handlers, not the transport). This
 * test pins that invariant so a future refactor that moved approval into
 * the stdio transport (and skipped it for HTTP) would fail loudly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import { startHttpListener } from '../../src/http-listener.js';
import { setApprovalEngine, gateApproval } from '../../src/approval/gate.js';
import { ManualApproval } from '../../src/approval/manual.js';

describe('approval engine path under HTTP transport', () => {
  let handle: Awaited<ReturnType<typeof startHttpListener>> | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    setApprovalEngine(null);
  });

  it('enqueues a PendingApproval before transport.exec is called', async () => {
    const manual = new ManualApproval({ webuiEnabled: true, timeout_ms: 60_000 });
    setApprovalEngine(manual);

    let execCalled = false;

    const mcp = new McpServer({
      name: 'test', version: '0.0.0-test', capabilities: { resources: {}, tools: {} },
    });
    mcp.tool(
      'fake-exec',
      'simulates exec',
      { command: z.string() },
      async ({ command }) => {
        // mirror real handler: gate, then "exec"
        await gateApproval({
          profile: { id: 'default' },
          tool: 'exec',
          command,
        });
        execCalled = true;
        return { content: [{ type: 'text' as const, text: 'ran' }] };
      },
    );

    handle = await startHttpListener(mcp, {
      bind: '127.0.0.1', port: 0, authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1', 'http://localhost'],
      requestTimeoutMs: 5000, skipRuntimeLock: true,
      env: { TOK: 'tok' },
    });

    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer tok', origin: 'http://127.0.0.1' } },
    });
    const client = new Client({ name: 'test', version: '0.0.0-test' }, { capabilities: {} });
    await client.connect(transport);

    // Fire-and-forget — the call will block on the manual approval queue.
    const inflight = client.callTool({ name: 'fake-exec', arguments: { command: 'ls' } });

    // Poll for the pending entry to materialize (approval is gated BEFORE exec)
    const deadline = Date.now() + 2000;
    let pending = manual.listPending();
    while (pending.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      pending = manual.listPending();
    }

    expect(pending.length).toBe(1);
    expect(execCalled).toBe(false);

    // Resolve allow so the inflight call settles.
    expect(manual.resolvePending(pending[0].id, 'allow', 'test', 'test')).toBe(true);
    const result = await inflight;
    expect(execCalled).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('ran');

    await client.close();
  });
});
