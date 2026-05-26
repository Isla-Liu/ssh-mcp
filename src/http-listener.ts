/**
 * Streamable HTTP MCP transport wrapper.
 *
 * Per P2 plan + task rev 2:
 *  - In-process StreamableHTTPServerTransport (SDK 1.29+).
 *  - Bearer middleware enforced BEFORE transport.handleRequest.
 *  - DNS rebinding protection MUST be enabled or allowedHosts/Origins are ignored.
 *  - Stateful session (randomUUID) so the warm SSH connection registry is reused.
 *  - Non-loopback bind WITHOUT a bearer token is fatal at boot.
 *  - On boot, write runtime.json; refuse start on a fresh-PID-alive collision.
 *  - Hooks for the audit-log card (see src/audit/http-context.ts).
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { sanitizeAuthHeaders } from './utils/shell.js';
import { isLoopbackBind } from './audit/http-context.js';
import {
  checkRuntimeCollision,
  clearRuntimeRecord,
  writeRuntimeRecord,
} from './runtime-lock.js';

export interface HttpListenerConfig {
  bind: string;
  port: number;
  /** NAME of env var (never the value). */
  authTokenEnv: string;
  originAllowlist: string[];
  /** Defaults to derived list from bind+port at startup. */
  allowedHosts?: string[];
  requestTimeoutMs: number;
  /** Test seam: allow runtime-lock collision check to be bypassed. */
  skipRuntimeLock?: boolean;
  /** Test seam: env map (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface HttpListenerHandle {
  /** node:http server, already listen()'d. */
  server: http.Server;
  /** SDK transport, already connected to the McpServer. */
  transport: StreamableHTTPServerTransport;
  /** Actual bound port (resolved when port=0 was passed). */
  port: number;
  /** Stop accepting, close transport, clear runtime lock. */
  close: () => Promise<void>;
  /**
   * Whether the bound interface is loopback. Audit hooks read this to decide
   * whether to populate `remote_addr`.
   */
  bindIsLoopback: boolean;
}

/**
 * Validate boot-time invariants. Throws to abort the boot before any TCP listen.
 *
 * Rules (mirrors P2 §4):
 *   - Non-loopback bind WITHOUT a token in `process.env[auth_token_env]` → fatal.
 *   - Loopback bind with empty token → allowed (logged WARN by caller).
 */
export function validateHttpBootInvariants(cfg: {
  bind: string;
  authTokenEnv: string;
  env?: NodeJS.ProcessEnv;
}): { token: string | undefined; bindIsLoopback: boolean } {
  const env = cfg.env ?? process.env;
  const token = env[cfg.authTokenEnv];
  const bindIsLoopback = isLoopbackBind(cfg.bind);
  if (!bindIsLoopback && (!token || token.length === 0)) {
    throw new Error(
      `Refusing to start: HTTP transport bound to non-loopback "${cfg.bind}" requires ` +
      `auth token via env var "${cfg.authTokenEnv}", which is empty or unset.`,
    );
  }
  return { token, bindIsLoopback };
}

function bytesEqualConstantTime(a: string, b: string): boolean {
  // timingSafeEqual requires equal length; pad to the longer side then compare,
  // then also verify length matched (so length-only attacks still bail out).
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Run a dummy compare to keep timing close.
    const pad = Buffer.alloc(Math.max(aBuf.length, bBuf.length));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/** Extract bearer token from `Authorization: Bearer <token>`. */
function extractBearer(authHeader: string | string[] | undefined): string | undefined {
  if (!authHeader) return undefined;
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof raw !== 'string') return undefined;
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  return m ? m[1] : undefined;
}

function defaultAllowedHosts(bind: string, port: number): string[] {
  // Always permit the canonical loopback aliases; if the operator bound
  // somewhere else, accept that exact host:port too.
  const set = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (bind && bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
    set.add(`${bind}:${port}`);
  }
  return Array.from(set);
}

/**
 * Build and start the HTTP listener. Connects the supplied McpServer to a
 * StreamableHTTPServerTransport routed on POST/GET/DELETE /mcp.
 *
 * The server is returned in already-listening state.
 */
export async function startHttpListener(
  mcp: McpServer,
  cfg: HttpListenerConfig,
): Promise<HttpListenerHandle> {
  const { token, bindIsLoopback } = validateHttpBootInvariants({
    bind: cfg.bind,
    authTokenEnv: cfg.authTokenEnv,
    env: cfg.env,
  });

  const allowedHostsExplicit = cfg.allowedHosts && cfg.allowedHosts.length > 0
    ? cfg.allowedHosts
    : undefined;

  // We construct the transport AFTER server.listen() so that when port=0
  // (ephemeral, e.g. tests), the SDK's allowedHosts uses the actual bound
  // port. SDK can't accept allowedHosts changes after construction.
  // Bind a placeholder http.Server first to discover the port, then build
  // the SDK transport with the right allowedHosts.

  const server = http.createServer();
  // Per-request socket timeout — closes hung connections without leaking.
  server.requestTimeout = cfg.requestTimeoutMs;
  server.headersTimeout = Math.min(60_000, cfg.requestTimeoutMs);

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    server.once('error', onErr);
    server.listen(cfg.port, cfg.bind, () => {
      server.off('error', onErr);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundPort = addr.port;

  const allowedHosts = allowedHostsExplicit ?? defaultAllowedHosts(cfg.bind, boundPort);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins: cfg.originAllowlist,
  });

  await mcp.connect(transport);

  server.on('request', (req, res) => {
    handleRequest(req, res, transport, token, cfg).catch((err) => {
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(sanitizeAuthHeaders(`Internal error: ${err?.message || err}`));
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    });
  });

  if (!cfg.skipRuntimeLock) {
    const collision = checkRuntimeCollision({ host: cfg.bind, port: boundPort });
    if (collision) {
      try { server.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
      throw new Error(
        `Refusing to start: another ssh-mcp instance (pid=${collision.existing.pid}, ` +
        `started_at=${collision.existing.started_at}) is already bound to port ${boundPort}. ` +
        `If it has crashed, remove ~/.ssh-mcp/runtime.json and retry.`,
      );
    }
    writeRuntimeRecord({
      pid: process.pid,
      host: cfg.bind,
      port: boundPort,
      started_at: new Date().toISOString(),
      transport: 'http',
    });
  }

  const close = async () => {
    if (!cfg.skipRuntimeLock) clearRuntimeRecord();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await transport.close(); } catch { /* ignore */ }
  };

  return { server, transport, port: boundPort, close, bindIsLoopback };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transport: StreamableHTTPServerTransport,
  token: string | undefined,
  cfg: HttpListenerConfig,
): Promise<void> {
  const url = req.url || '/';

  // Lightweight healthz (no auth) — useful for orchestrators.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/healthz' || url === '/health')) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (!url.startsWith('/mcp')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return;
  }

  // Bearer enforcement BEFORE the transport sees the request.
  if (token && token.length > 0) {
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !bytesEqualConstantTime(presented, token)) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('WWW-Authenticate', 'Bearer realm="ssh-mcp"');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  // Defense-in-depth Origin enforcement (SDK also checks, but emit a clean 403
  // here so logs are unambiguous and any audit-log card sees the rejection).
  const origin = req.headers.origin;
  if (origin && cfg.originAllowlist.length > 0) {
    const ok = cfg.originAllowlist.some((allowed) => origin === allowed || origin.startsWith(allowed));
    if (!ok) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return;
    }
  }

  await transport.handleRequest(req, res);
}
