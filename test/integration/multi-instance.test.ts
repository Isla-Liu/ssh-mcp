/**
 * Integration: second startHttpListener with same {host, port} within the
 * 2-min window must refuse start (R1 §7 RED #2).
 *
 * We run the runtime-lock path with a real ~/.ssh-mcp file in a tmp HOME
 * override so we don't trash the developer's runtime.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { startHttpListener } from '../../src/http-listener.js';
import {
  writeRuntimeRecord,
  runtimeFile,
  clearRuntimeRecord,
} from '../../src/runtime-lock.js';

function makeMcp(): McpServer {
  return new McpServer({
    name: 'test', version: '0.0.0', capabilities: { resources: {}, tools: {} },
  });
}

describe('multi-instance race guard', () => {
  let prevHome: string | undefined;
  let tmpHome: string;
  let handle: Awaited<ReturnType<typeof startHttpListener>> | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses start when a fresh record for the same port + live PID exists', async () => {
    const parent = process.ppid;
    if (!parent || parent === process.pid) return; // skip if we can't get a known-alive sibling pid

    // Start once to discover an actual port we can collide on. Note this is
    // its own listener; we close it then forge a runtime.json with parent PID
    // for the *same* port. (We can't bind twice anyway, so the port is free
    // by the time the second startHttpListener runs.)
    const first = await startHttpListener(makeMcp(), {
      bind: '127.0.0.1', port: 0, authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1'],
      requestTimeoutMs: 5000,
      skipRuntimeLock: true, // first one writes nothing — we control the file
      env: { TOK: 't' },
    });
    const port = first.port;
    await first.close();

    writeRuntimeRecord({
      pid: parent,
      host: '127.0.0.1',
      port,
      started_at: new Date().toISOString(),
      transport: 'http',
    });

    await expect(
      startHttpListener(makeMcp(), {
        bind: '127.0.0.1', port, authTokenEnv: 'TOK',
        originAllowlist: ['http://127.0.0.1'],
        requestTimeoutMs: 5000,
        env: { TOK: 't' },
      }),
    ).rejects.toThrow(/another ssh-mcp/i);

    // cleanup
    try { fs.unlinkSync(runtimeFile()); } catch { /* ignore */ }
  });

  it('does NOT refuse when no record exists (clean boot)', async () => {
    handle = await startHttpListener(makeMcp(), {
      bind: '127.0.0.1', port: 0, authTokenEnv: 'TOK',
      originAllowlist: ['http://127.0.0.1'],
      requestTimeoutMs: 5000,
      env: { TOK: 't' },
    });
    expect(handle.port).toBeGreaterThan(0);
    // record was written
    const rec = JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
    expect(rec.pid).toBe(process.pid);
    expect(rec.transport).toBe('http');
  });
});
