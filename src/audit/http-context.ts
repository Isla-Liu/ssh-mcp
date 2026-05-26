/**
 * Tiny helper for building the audit-record fields that depend on the MCP
 * transport. The actual audit-log writer ships in a separate card; this
 * module only owns the shape contract.
 *
 * TODO(audit-log): once src/audit/logger.ts lands, import its record type
 * and consume `buildHttpAuditFields(req)` inside the HTTP listener's
 * onmessage hook so every tool-call audit row carries the transport context.
 * Tracked under the audit-log integration card (sibling to the HTTP transport
 * card). Until then the http-listener attaches these fields to the per-request
 * object passed into the transport, so downstream wiring is one rename away.
 */

import type { IncomingMessage } from 'node:http';

export interface HttpAuditFields {
  transport: 'http';
  /** Bearer header WAS present on the request (never the value). */
  bearer_present: boolean;
  /** Populated only when the bound interface was non-loopback; omitted otherwise. */
  remote_addr?: string;
  /** MCP-session-id surfaced by the SDK; useful for stitching multi-call sessions. */
  mcp_session_id?: string;
}

export interface StdioAuditFields {
  transport: 'stdio';
  bearer_present: false;
}

export type TransportAuditFields = HttpAuditFields | StdioAuditFields;

const LOOPBACK = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK.has(bind);
}

export function isLoopbackRemote(addr: string | undefined): boolean {
  if (!addr) return true;
  return LOOPBACK.has(addr);
}

export function buildHttpAuditFields(
  req: IncomingMessage,
  bindIsLoopback: boolean,
  mcpSessionId?: string,
): HttpAuditFields {
  const hasAuth = typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
  const remote = req.socket?.remoteAddress;
  const fields: HttpAuditFields = {
    transport: 'http',
    bearer_present: hasAuth,
  };
  if (!bindIsLoopback && remote && !isLoopbackRemote(remote)) {
    fields.remote_addr = remote;
  }
  if (mcpSessionId) {
    fields.mcp_session_id = mcpSessionId;
  }
  return fields;
}

export function buildStdioAuditFields(): StdioAuditFields {
  return { transport: 'stdio', bearer_present: false };
}
