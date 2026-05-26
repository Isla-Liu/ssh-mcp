/**
 * Integration test: full MCP handshake over real loopback HTTP.
 *
 *   initialize → list_tools → call(echo)
 *
 * Uses the SDK's StreamableHTTPClientTransport so we exercise the same code
 * path a real consumer (Hermes gateway, Claude, etc.) would hit.
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
    handle = await startHttpListener(makeMcp(), {
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
});
