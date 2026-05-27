/**
 * Streamable HTTP MCP transport wrapper.
 *
 * Per P2 plan + task rev 2 + EPIC2 multi-session fix:
 *  - In-process StreamableHTTPServerTransport (SDK 1.x).
 *  - Bearer middleware enforced BEFORE transport lookup (don't leak the
 *    session-id map to anonymous callers).
 *  - DNS rebinding protection MUST be enabled or allowedHosts/Origins are ignored.
 *  - **Stateful multi-session**: one StreamableHTTPServerTransport + one McpServer
 *    per `Mcp-Session-Id`. Dispatch by header on subsequent requests. Mint a
 *    new pair on a fresh POST /mcp with `method: "initialize"` and no session id.
 *    See SDK example sseAndStreamableHttpCompatibleServer.js — the same pattern.
 *  - Idle expiry sweep evicts abandoned sessions; hard cap protects memory.
 *  - Non-loopback bind WITHOUT a bearer token is fatal at boot.
 *  - On boot, write runtime.json; refuse start on a fresh-PID-alive collision.
 *  - Hooks for the audit-log card (see src/audit/http-context.ts).
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { sanitizeAuthHeaders } from './utils/shell.js';
import { isLoopbackBind } from './audit/http-context.js';
import {
  checkRuntimeCollision,
  clearRuntimeRecord,
  writeRuntimeRecord,
} from './runtime-lock.js';

/**
 * Factory producing a fresh McpServer (with all tools registered) per session.
 *
 * Why a factory? `Protocol.connect(transport)` stores the transport on the
 * McpServer's underlying Protocol instance (`this._transport = transport`). Re-
 * using one McpServer across multiple transports would clobber `_transport` on
 * each new connect and break previously-established sessions. So each session
 * gets a dedicated McpServer wired to a dedicated transport.
 */
export type McpServerFactory = () => McpServer | Promise<McpServer>;

/** Back-compat: legacy callers can still pass a single McpServer instance. */
export type McpServerOrFactory = McpServer | McpServerFactory;

export interface HttpListenerConfig {
  bind: string;
  port: number;
  /** NAME of env var (never the value). */
  authTokenEnv: string;
  originAllowlist: string[];
  /** Defaults to derived list from bind+port at startup. */
  allowedHosts?: string[];
  requestTimeoutMs: number;
  /**
   * Idle-eviction window in ms. A session whose transport has not handled a
   * request for this long is closed and removed from the registry. Defaults to
   * 30 minutes. Set to 0 to disable idle eviction (NOT recommended — sessions
   * will leak).
   */
  sessionIdleMs?: number;
  /**
   * Maximum concurrent sessions. If a new initialize arrives while at-cap, the
   * oldest idle session is evicted to make room. Defaults to 256.
   */
  maxSessions?: number;
  /** Test seam: allow runtime-lock collision check to be bypassed. */
  skipRuntimeLock?: boolean;
  /** Test seam: env map (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface HttpListenerHandle {
  /** node:http server, already listen()'d. */
  server: http.Server;
  /** Actual bound port (resolved when port=0 was passed). */
  port: number;
  /** Stop accepting, close all transports, clear runtime lock. */
  close: () => Promise<void>;
  /**
   * Whether the bound interface is loopback. Audit hooks read this to decide
   * whether to populate `remote_addr`.
   */
  bindIsLoopback: boolean;
  /** Number of currently live MCP sessions (testing/observability). */
  activeSessions: () => number;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;

interface SessionRecord {
  id: string;
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  lastActiveAt: number;
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
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    const pad = Buffer.alloc(Math.max(aBuf.length, bBuf.length));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/** Extract bearer token from `Authorization: Bearer ***`. */
function extractBearer(authHeader: string | string[] | undefined): string | undefined {
  if (!authHeader) return undefined;
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof raw !== 'string') return undefined;
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  return m ? m[1] : undefined;
}

function defaultAllowedHosts(bind: string, port: number): string[] {
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

function pickSessionIdHeader(req: http.IncomingMessage): string | undefined {
  // Header lookup is lowercased by Node; spec name is `Mcp-Session-Id`.
  const raw = req.headers['mcp-session-id'];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const LIMIT = 4 * 1024 * 1024; // 4 MiB — matches SDK MAXIMUM_MESSAGE_SIZE
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > LIMIT) {
      throw new Error('payload too large');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

/**
 * Build and start the HTTP listener. Connects a per-session
 * StreamableHTTPServerTransport + McpServer pair routed on POST/GET/DELETE /mcp.
 *
 * `mcpOrFactory` may be either:
 *   - a single McpServer instance (legacy / single-session callers — first
 *     session connects to it; subsequent sessions cannot re-use it and will
 *     receive a fresh server only if a factory is provided); or
 *   - a factory `() => McpServer` invoked once per new session (recommended).
 *
 * The server is returned in already-listening state.
 */
export async function startHttpListener(
  mcpOrFactory: McpServerOrFactory,
  cfg: HttpListenerConfig,
): Promise<HttpListenerHandle> {
  const { token, bindIsLoopback } = validateHttpBootInvariants({
    bind: cfg.bind,
    authTokenEnv: cfg.authTokenEnv,
    env: cfg.env,
  });

  const sessionIdleMs = cfg.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxSessions = cfg.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // Normalize to a factory. If caller passed a McpServer, wrap it but only
  // allow it to be consumed ONCE — afterward subsequent sessions cannot reuse
  // it (the SDK's Protocol class overwrites `_transport` on each connect, so
  // re-using would silently break earlier sessions).
  let usedSingleton = false;
  const factory: McpServerFactory = (() => {
    if (typeof mcpOrFactory === 'function') {
      return mcpOrFactory as McpServerFactory;
    }
    return () => {
      if (usedSingleton) {
        throw new Error(
          'startHttpListener: single McpServer instance cannot be reused across ' +
          'multiple sessions. Pass a factory `() => new McpServer(...)` instead.',
        );
      }
      usedSingleton = true;
      return mcpOrFactory as McpServer;
    };
  })();

  const allowedHostsExplicit = cfg.allowedHosts && cfg.allowedHosts.length > 0
    ? cfg.allowedHosts
    : undefined;

  const server = http.createServer();
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

  // Session registry, keyed by Mcp-Session-Id (the SDK-minted UUID).
  const sessions = new Map<string, SessionRecord>();

  /** Drop a session: close transport + mcp, then remove from registry. */
  async function dropSession(id: string): Promise<void> {
    const rec = sessions.get(id);
    if (!rec) return;
    sessions.delete(id);
    try { await rec.transport.close(); } catch { /* ignore */ }
    try { await rec.mcp.close(); } catch { /* ignore */ }
  }

  /** Evict idle sessions older than the configured TTL. */
  function sweepIdle(): void {
    if (sessionIdleMs <= 0) return;
    const cutoff = Date.now() - sessionIdleMs;
    for (const [id, rec] of sessions) {
      if (rec.lastActiveAt < cutoff) {
        void dropSession(id);
      }
    }
  }

  // Periodic idle sweep. unref() so it doesn't keep the event loop alive.
  // Cadence: ttl/6, clamped to [50ms, 60s] — small enough to be useful in
  // tests with tight TTLs, large enough to be cheap in production.
  const sweepHandle = sessionIdleMs > 0
    ? setInterval(sweepIdle, Math.min(60_000, Math.max(50, Math.floor(sessionIdleMs / 6))))
    : undefined;
  sweepHandle?.unref?.();

  async function createSession(): Promise<SessionRecord> {
    // Enforce hard cap; evict the LRU entry if at-capacity.
    if (sessions.size >= maxSessions) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, rec] of sessions) {
        if (rec.lastActiveAt < oldestAt) {
          oldestAt = rec.lastActiveAt;
          oldestId = id;
        }
      }
      if (oldestId) await dropSession(oldestId);
    }

    const mcp = await factory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins: cfg.originAllowlist,
      onsessioninitialized: (sessionId: string) => {
        // Index the session as soon as the SDK has minted its id.
        const rec: SessionRecord = {
          id: sessionId,
          transport,
          mcp,
          lastActiveAt: Date.now(),
        };
        sessions.set(sessionId, rec);
      },
    });

    // If the transport closes for any reason (client DELETE, network error,
    // SDK-level fault), make sure the registry doesn't keep a stale entry.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) void dropSession(id);
    };

    await mcp.connect(transport);
    return { id: '', transport, mcp, lastActiveAt: Date.now() };
  }

  server.on('request', (req, res) => {
    handleRequest(req, res, {
      token,
      cfg,
      sessions,
      createSession,
      dropSession,
    }).catch((err) => {
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
    if (sweepHandle) clearInterval(sweepHandle);
    if (!cfg.skipRuntimeLock) clearRuntimeRecord();
    // Close all live sessions first so in-flight handlers see proper teardown.
    const ids = Array.from(sessions.keys());
    await Promise.all(ids.map((id) => dropSession(id)));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    port: boundPort,
    close,
    bindIsLoopback,
    activeSessions: () => sessions.size,
  };
}

interface HandleCtx {
  token: string | undefined;
  cfg: HttpListenerConfig;
  sessions: Map<string, SessionRecord>;
  createSession: () => Promise<SessionRecord>;
  dropSession: (id: string) => Promise<void>;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandleCtx,
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

  // Bearer enforcement BEFORE we touch the session-id map. This prevents
  // anonymous callers from probing session ids or forcing session churn.
  if (ctx.token && ctx.token.length > 0) {
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !bytesEqualConstantTime(presented, ctx.token)) {
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
  if (origin && ctx.cfg.originAllowlist.length > 0) {
    const ok = ctx.cfg.originAllowlist.some(
      (allowed) => origin === allowed || origin.startsWith(allowed),
    );
    if (!ok) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return;
    }
  }

  const sessionId = pickSessionIdHeader(req);

  // POST with no session id → must be an initialize. Read body once, inspect,
  // route accordingly. Pass the parsed body into the SDK so it doesn't try to
  // re-read the stream.
  if (req.method === 'POST' && !sessionId) {
    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch (err: any) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: `Parse error: ${err?.message || 'invalid JSON'}` },
        id: null,
      }));
      return;
    }

    const looksInit = Array.isArray(parsedBody)
      ? parsedBody.some((m) => isInitializeRequest(m))
      : isInitializeRequest(parsedBody);

    if (!looksInit) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Bad Request: missing Mcp-Session-Id header and not an initialize request',
        },
        id: null,
      }));
      return;
    }

    const rec = await ctx.createSession();
    rec.lastActiveAt = Date.now();
    await rec.transport.handleRequest(req, res, parsedBody);
    return;
  }

  // All other paths require a known session id.
  if (!sessionId) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad Request: missing Mcp-Session-Id header' },
      id: null,
    }));
    return;
  }

  const rec = ctx.sessions.get(sessionId);
  if (!rec) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found or expired' },
      id: null,
    }));
    return;
  }

  rec.lastActiveAt = Date.now();
  await rec.transport.handleRequest(req, res);
}
