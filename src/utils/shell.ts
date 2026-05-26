import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Validate and trim a command string. Enforces maxChars if finite.
 * Shared by both transports so limit semantics are identical.
 */
export function sanitizeCommand(command: string, maxChars: number): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }

  if (Number.isFinite(maxChars) && trimmedCommand.length > maxChars) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Command is too long (max ${maxChars} characters)`
    );
  }

  return trimmedCommand;
}

/**
 * Return undefined for empty/non-string; otherwise the raw password.
 * No content mutation, no logging.
 */
export function sanitizePassword(password: string | undefined): string | undefined {
  if (typeof password !== 'string') return undefined;
  if (password.length === 0) return undefined;
  return password;
}

/**
 * Escape a command for safe embedding inside a single-quoted POSIX shell
 * context on the remote side, e.g. `sh -c '<escaped>'`. Applies the canonical
 * `'\''` technique: close-quote, escape a single quote, re-open-quote.
 */
export function escapeCommandForShell(command: string): string {
  return command.replace(/'/g, "'\"'\"'");
}

/**
 * Redact secret-bearing substrings from a string before it lands in audit
 * logs or stderr echoes.
 *
 * Covers:
 *   - `Authorization: Bearer <token>` (RFC 7235 — common in HTTP transport)
 *   - `Authorization: <scheme> <token>` (generic)
 *   - `Bearer <token>` (loose forms in error strings)
 *   - `token=...`, `api_key=...`, `apiKey=...`, `key=...`, `password=...`
 *     in query-string/form/JSON-ish contexts
 *
 * The redaction policy is intentionally aggressive: false positives just
 * mask harmless query params, but a single leaked bearer token is fatal.
 * See R1 §7 RED #1 — HTTP transport adds an auth header surface that
 * sanitizePassword alone did not cover.
 */
export function sanitizeAuthHeaders(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;

  // Authorization: Bearer <token>   /   Authorization: <scheme> <token>
  out = out.replace(
    /(Authorization\s*:\s*)([A-Za-z][A-Za-z0-9._~+\/-]*\s+)([A-Za-z0-9._~+\/=-]+)/gi,
    (_m, p1: string, p2: string) => `${p1}${p2}***REDACTED***`,
  );

  // Bare "Bearer <token>" anywhere (e.g. inside an error message)
  out = out.replace(
    /(Bearer\s+)([A-Za-z0-9._~+\/=-]+)/g,
    (_m, p1: string) => `${p1}***REDACTED***`,
  );

  // Common credential-bearing query/body keys:
  //   token=... api_key=... apiKey=... key=... password=... pwd=... secret=...
  // Match until the next & or whitespace or quote or end-of-string.
  // Allow optional surrounding quotes around the key name (JSON-ish forms).
  out = out.replace(
    /(["']?\b(?:token|api[_-]?key|key|password|pwd|secret)\b["']?)\s*[=:]\s*"?([^"&\s,;}]+)"?/gi,
    (_m, p1: string) => `${p1}=***REDACTED***`,
  );

  return out;
}
