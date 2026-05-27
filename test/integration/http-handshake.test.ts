/**
 * Integration test: full MCP handshake over real loopback HTTP.
 *
 *   initialize → list_tools → call(echo)
 *
 * Uses the SDK's StreamableHTTPClientTransport so we exercise the same code
 * path a real consumer (Hermes gateway, Claude, etc.) would hit.
 *
 * Also exercises the multi-session regression (EPIC2/V3): the original code
 * pinned a single transport+server instance per process, so a second client
 * `initialize` returned 400 `Server already initialized`. The fix uses a
 * per-session transport + McpServer keyed by Mcp-Session-Id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import { startHttpListener } from '../../src/http-listener.js';

function makeMcp(): McpServer {
  const s = new McpServer({
    name: 'test-server',
    version: '0.0.0-test',
    capabilities: { resources: {}, tools: {} },
  });
  s.tool(
    'echo',
    'echo back the argument',
    { msg: z.string() },
    async ({ msg }) => ({ content: [{ type: 'text' as const, text: msg }] }),
  );
  return s;
}

describe('HTTP MCP handshake (loopback + bearer)', () => {
  let handle: Awaited<ReturnType<typeof startHttpListener>>;

  beforeEach(async () => {
    handle = await startHttpListener(makeMcp, {
      bind: '127.0.0.1',
      port: 0,
      authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1', 'http://localhost'],
      requestTimeoutMs: 10_000,
      skipRuntimeLock: true,
      env: { TOK: 'integration-token' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('initialize → list tools → call echo', async () => {
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: 'Bearer integration-token',
          origin: 'http://127.0.0.1',
        },
      },
    });
    const client = new Client(
      { name: 'test-client', version: '0.0.0-test' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('echo');

    const result = await client.callTool({ name: 'echo', arguments: { msg: 'hello' } });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('hello');

    await client.close();
  });

  /**
   * EPIC2/V3 regression: prior implementation reused a single
   * StreamableHTTPServerTransport for every request. The first initialize
   * pinned `_sessionId`, then a second initialize would 400 with
   * `Invalid Request: Server already initialized`.
   *
   * Behavior after the fix: each fresh `initialize` (no Mcp-Session-Id header)
   * mints its own transport + McpServer, both clients work in parallel.
   */
  it('two sequential initialize calls both succeed (no `Server already initialized`)', async () => {
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const reqInit = {
      headers: {
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
      },
    };

    const c1 = new Client({ name: 'c1', version: '0.0.0' }, { capabilities: {} });
    await c1.connect(new StreamableHTTPClientTransport(url, { requestInit: reqInit }));

    const c2 = new Client({ name: 'c2', version: '0.0.0' }, { capabilities: {} });
    await c2.connect(new StreamableHTTPClientTransport(url, { requestInit: reqInit }));

    // Both clients can call echo independently.
    const r1 = await c1.callTool({ name: 'echo', arguments: { msg: 'one' } });
    const r2 = await c2.callTool({ name: 'echo', arguments: { msg: 'two' } });
    expect((r1.content as any)[0].text).toBe('one');
    expect((r2.content as any)[0].text).toBe('two');

    expect(handle.activeSessions()).toBe(2);

    await c1.close();
    await c2.close();
  });

  /**
   * Same regression, but parallel: two `initialize` requests race the listener.
   * Both must succeed with distinct session ids.
   */
  it('parallel initialize calls both succeed with distinct session ids', async () => {
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const reqInit = {
      headers: {
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
      },
    };

    const c1 = new Client({ name: 'c1', version: '0.0.0' }, { capabilities: {} });
    const c2 = new Client({ name: 'c2', version: '0.0.0' }, { capabilities: {} });
    const t1 = new StreamableHTTPClientTransport(url, { requestInit: reqInit });
    const t2 = new StreamableHTTPClientTransport(url, { requestInit: reqInit });

    await Promise.all([c1.connect(t1), c2.connect(t2)]);

    // SDK exposes the session id once initialize has settled.
    const sid1 = (t1 as any).sessionId;
    const sid2 = (t2 as any).sessionId;
    expect(typeof sid1).toBe('string');
    expect(typeof sid2).toBe('string');
    expect(sid1).not.toBe(sid2);

    await Promise.all([c1.close(), c2.close()]);
  });

  /**
   * Requests with a bogus session id must 404, not silently fall back to
   * "first transport on the box". This is what made the original bug
   * undetectable in casual testing.
   */
  it('returns 404 when the Mcp-Session-Id is unknown', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
        'mcp-session-id': 'definitely-not-a-real-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * Plain POST without an `initialize` method and without a session id is a
   * client error — neither path should silently create a transport.
   */
  it('returns 400 when POST has no session id and is not initialize', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
  });

  /**
   * DELETE /mcp with a valid session id must tear that session down and remove
   * it from the registry, so a follow-up request with the same id 404s.
   */
  it('DELETE /mcp drops the session from the registry', async () => {
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const reqInit = {
      headers: {
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
      },
    };
    const transport = new StreamableHTTPClientTransport(url, { requestInit: reqInit });
    const client = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    await client.connect(transport);

    expect(handle.activeSessions()).toBe(1);
    const sid = (transport as any).sessionId as string;
    expect(typeof sid).toBe('string');

    // Issue DELETE directly so we can observe the registry drop.
    const del = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
        'mcp-session-id': sid,
      },
    });
    expect([200, 204]).toContain(del.status);

    // Session must be gone now.
    expect(handle.activeSessions()).toBe(0);

    // Follow-up call on the dead id must 404.
    const followup = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer integration-token',
        origin: 'http://127.0.0.1',
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(followup.status).toBe(404);

    try { await client.close(); } catch { /* already closed */ }
  });

  /**
   * Idle-eviction sweep: a session whose transport hasn't seen traffic for
   * longer than `sessionIdleMs` is closed and removed automatically. We use a
   * short TTL (200ms) and let the periodic sweeper run.
   */
  it('evicts sessions idle for longer than sessionIdleMs', async () => {
    // Spin up a dedicated listener with a tight idle TTL.
    const shortHandle = await startHttpListener(makeMcp, {
      bind: '127.0.0.1',
      port: 0,
      authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1'],
      requestTimeoutMs: 5_000,
      skipRuntimeLock: true,
      sessionIdleMs: 200,
      env: { TOK: 'integration-token' },
    });

    try {
      const url = new URL(`http://127.0.0.1:${shortHandle.port}/mcp`);
      const reqInit = {
        headers: {
          authorization: 'Bearer integration-token',
          origin: 'http://127.0.0.1',
        },
      };
      const client = new Client({ name: 'c', version: '0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: reqInit }));
      expect(shortHandle.activeSessions()).toBe(1);

      // Wait long enough for the sweep interval (~ttl/6 = ~33ms) to fire.
      await new Promise((r) => setTimeout(r, 600));
      expect(shortHandle.activeSessions()).toBe(0);

      try { await client.close(); } catch { /* already evicted */ }
    } finally {
      await shortHandle.close();
    }
  });
});

/**
 * Hard cap: with maxSessions=1, a second initialize must evict the oldest
 * session (LRU) to make room. Lives in its own describe so we can size the
 * listener tightly without affecting the other tests.
 */
describe('HTTP MCP handshake — session cap', () => {
  it('evicts the oldest session when at maxSessions cap', async () => {
    const handle = await startHttpListener(makeMcp, {
      bind: '127.0.0.1',
      port: 0,
      authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1'],
      requestTimeoutMs: 5_000,
      skipRuntimeLock: true,
      maxSessions: 1,
      env: { TOK: 'integration-token' },
    });
    try {
      const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
      const reqInit = {
        headers: {
          authorization: 'Bearer integration-token',
          origin: 'http://127.0.0.1',
        },
      };
      const c1 = new Client({ name: 'c1', version: '0' }, { capabilities: {} });
      await c1.connect(new StreamableHTTPClientTransport(url, { requestInit: reqInit }));
      expect(handle.activeSessions()).toBe(1);

      const c2 = new Client({ name: 'c2', version: '0' }, { capabilities: {} });
      await c2.connect(new StreamableHTTPClientTransport(url, { requestInit: reqInit }));
      // Cap is 1: oldest got evicted, only c2 remains.
      expect(handle.activeSessions()).toBe(1);

      try { await c1.close(); } catch { /* already evicted */ }
      try { await c2.close(); } catch { /* already evicted */ }
    } finally {
      await handle.close();
    }
  });
});
