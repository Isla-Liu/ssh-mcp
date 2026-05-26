/**
 * Multi-instance race guard (R1 §7 RED #2).
 *
 * On boot, the HTTP listener writes ~/.ssh-mcp/runtime.json with
 * {pid, host, port, started_at, transport}. If the file already exists,
 * was written less than 2 minutes ago, the recorded PID is still alive,
 * AND the recorded port matches what this process is about to bind, we
 * refuse to start.
 *
 * The 2-minute freshness window is a compromise: long enough to catch
 * concurrent boots, short enough that an actual crashed-and-relaunched
 * scenario doesn't get stuck refusing to start once the OS recycles the PID.
 *
 * Same logic on WSL (~/.ssh-mcp/runtime.json) and on the Windows host
 * (%USERPROFILE%\.ssh-mcp\runtime.json) — os.homedir() returns the right
 * thing on both.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface RuntimeRecord {
  pid: number;
  host: string;
  port: number;
  started_at: string; // ISO 8601
  transport: 'stdio' | 'http';
}

export const FRESH_WINDOW_MS = 120_000;

export function runtimeDir(): string {
  return path.join(os.homedir(), '.ssh-mcp');
}

export function runtimeFile(): string {
  return path.join(runtimeDir(), 'runtime.json');
}

/** Returns true if process is alive. Uses signal 0 (no-op probe). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = no such process. EPERM = exists but unsigned-for; treat as alive.
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

export interface CollisionDetail {
  reason: 'fresh-record' | 'pid-alive' | 'port-match';
  existing: RuntimeRecord;
}

/**
 * Read existing runtime record. Returns undefined when missing/unreadable/
 * stale-on-disk. Throws only on JSON parse failures (malformed).
 */
export function readRuntimeRecord(file = runtimeFile()): RuntimeRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') {
      return parsed as RuntimeRecord;
    }
  } catch {
    // malformed — treat as absent so a stale, garbled file doesn't permanently lock us out
    return undefined;
  }
  return undefined;
}

/**
 * Decide whether a fresh attempt to bind {host, port} should be refused.
 * Returns the collision detail when a refusal is required, undefined when OK.
 *
 * Pure function (host/port + clock + fs read) — easy to unit-test.
 */
export function checkRuntimeCollision(args: {
  host: string;
  port: number;
  now?: number;
  file?: string;
}): CollisionDetail | undefined {
  const file = args.file ?? runtimeFile();
  const existing = readRuntimeRecord(file);
  if (!existing) return undefined;

  const now = args.now ?? Date.now();
  const startedAtMs = Date.parse(existing.started_at);
  if (!Number.isFinite(startedAtMs)) return undefined;
  const ageMs = now - startedAtMs;
  if (ageMs > FRESH_WINDOW_MS) return undefined;

  // Same record we wrote ourselves on a previous boot? Skip self-collisions.
  if (existing.pid === process.pid) return undefined;

  if (!isPidAlive(existing.pid)) return undefined;
  if (existing.port !== args.port) return undefined;

  return { reason: 'port-match', existing };
}

/** Write our runtime record. Creates the directory if needed. */
export function writeRuntimeRecord(rec: RuntimeRecord, file = runtimeFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Remove our runtime record. Best-effort. */
export function clearRuntimeRecord(file = runtimeFile()): void {
  try {
    const existing = readRuntimeRecord(file);
    // Only delete if it's still our record — avoid clobbering a successor.
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(file);
    }
  } catch {
    // best effort
  }
}
