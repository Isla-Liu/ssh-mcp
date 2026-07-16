import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { isFailedExecResult, resultToMcpContent } from '../src/index';
import { Ssh2Transport } from '../src/transports/ssh2';
import type { ExecResult } from '../src/transports/types';

// Regression: previously any non-empty stderr threw "Error (code 0):" even when
// the command exited 0. sudo-exec via ssh2 transport reliably tripped this
// because sudo `-p "" -S` writes a trailing newline to stderr after consuming
// the password, and many tools (curl/git/apt/dotnet) emit progress on stderr.

describe('resultToMcpContent', () => {
  const baseOk: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

  function failureMessage(result: ExecResult): string {
    try {
      resultToMcpContent(result);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      return (err as McpError).message;
    }
    throw new Error('expected resultToMcpContent to throw');
  }

  it('returns stdout on plain success', () => {
    const r = resultToMcpContent({ ...baseOk, stdout: 'hello\n' });
    expect(r.content[0]).toEqual({ type: 'text', text: 'hello\n' });
  });

  it('does NOT throw on exit 0 with stderr (regression for sudo-exec "Error (code 0):")', () => {
    const r = resultToMcpContent({
      stdout: 'uid=0(root)\n',
      stderr: '\n', // sudo -S trailing newline
      exitCode: 0,
    });
    expect((r.content[0] as any).type).toBe('text');
    // Whitespace-only stderr is dropped; stdout is returned as-is.
    expect((r.content[0] as any).text).toBe('uid=0(root)\n');
  });

  it('appends substantive stderr to stdout on exit 0', () => {
    const r = resultToMcpContent({
      stdout: 'apt output\n',
      stderr: 'WARNING: apt does not have a stable CLI interface.\n',
      exitCode: 0,
    });
    const text = (r.content[0] as any).text as string;
    expect(text).toContain('apt output');
    // Substantive stderr is appended directly to stdout (no [stderr] label).
    expect(text).toContain('stable CLI interface');
    expect(text).toBe('apt output\nWARNING: apt does not have a stable CLI interface.');
  });

  it('returns stderr-only output when stdout is empty and exit 0', () => {
    const r = resultToMcpContent({
      stdout: '',
      stderr: 'progress info on stderr\n',
      exitCode: 0,
    });
    expect((r.content[0] as any).text).toBe('progress info on stderr');
  });

  it('throws on non-zero exit with stderr', () => {
    expect(() => resultToMcpContent({
      stdout: '',
      stderr: 'permission denied\n',
      exitCode: 1,
    })).toThrow(McpError);
  });

  it('keeps exit status context when stderr is whitespace-only', () => {
    const message = failureMessage({ stdout: '', stderr: ' \r\n\t', exitCode: 7 });
    expect(message).toContain('Command exited with status 7');
  });

  it('filters a warning-only stderr stream without hiding the non-zero exit status', () => {
    const message = failureMessage({
      stdout: '',
      stderr: "Warning: Permanently added 'host' (ED25519) to the list of known hosts.\n",
      exitCode: 23,
    });
    expect(message).toContain('Command exited with status 23');
    expect(message).not.toContain('Permanently added');
  });

  it('puts exit status first, then substantive filtered stderr, and omits warning noise', () => {
    const message = failureMessage({
      stdout: 'stdout fallback must not outrank stderr',
      stderr: "Warning: Permanently added 'host' (ED25519) to the list of known hosts.\nreal stderr detail\n",
      exitCode: 9,
    });
    expect(message).toMatch(/Command exited with status 9\nreal stderr detail/);
    expect(message).not.toContain('Permanently added');
    expect(message).not.toContain('stdout fallback');
  });

  it('uses substantive stdout after status when filtered stderr has no diagnostic', () => {
    const message = failureMessage({
      stdout: 'command printed failure context on stdout\n',
      stderr: '\n',
      exitCode: 4,
    });
    expect(message).toMatch(/Command exited with status 4\ncommand printed failure context on stdout/);
  });

  it('reports signal-only termination as failure and retains diagnostics', () => {
    const result: ExecResult = {
      stdout: '',
      stderr: 'terminated during cleanup\n',
      exitCode: null,
      signal: 'SIGTERM',
    };
    const message = failureMessage(result);
    expect(message).toMatch(/Command terminated by signal SIGTERM\nterminated during cleanup/);
    expect(isFailedExecResult(result)).toBe(true);
  });

  it('reports both status and signal when a transport supplies both', () => {
    const message = failureMessage({
      stdout: '',
      stderr: '',
      exitCode: 143,
      signal: 'SIGTERM',
    });
    expect(message).toContain('Command exited with status 143 (signal SIGTERM)');
  });

  it('treats null exitCode as 0 (legacy ssh2 close without code)', () => {
    const r = resultToMcpContent({
      stdout: 'data',
      stderr: '\r\n',
      exitCode: null,
    });
    expect((r.content[0] as any).text).toBe('data');
  });

  it('routes timeout category to typed error', () => {
    expect(() => resultToMcpContent({
      stdout: '',
      stderr: 'Command execution timed out after 60000ms',
      exitCode: null,
      category: 'timeout',
    })).toThrow(McpError);
  });

  it('routes auth category to typed error', () => {
    expect(() => resultToMcpContent({
      stdout: '',
      stderr: 'permission denied (publickey)',
      exitCode: 255,
      category: 'auth',
    })).toThrow(/SSH authentication error/);
  });
});

describe('Ssh2Transport signal exit propagation', () => {
  it('preserves a signal-only channel close as a failed remote exit', async () => {
    class FakeStream extends EventEmitter {
      stderr = new EventEmitter();
      write = vi.fn();
      end = vi.fn();
    }

    const stream = new FakeStream();
    const exec = vi.fn((_command: string, callback: (err: Error | undefined, stream: FakeStream) => void) => {
      callback(undefined, stream);
    });
    const transport = new Ssh2Transport({ host: 'h', port: 22, username: 'u' });
    (transport as any).manager = {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      getSuPassword: vi.fn().mockReturnValue(undefined),
      getConnection: vi.fn().mockReturnValue({ exec }),
      getSuShell: vi.fn().mockReturnValue(null),
    };

    const pending = transport.exec('kill -TERM $$', { timeoutMs: 60000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.emit('close', null, 'SIGTERM');
    const result = await pending;

    expect(result).toMatchObject({
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: 'SIGTERM',
      category: 'remote_exit',
    });
    expect(() => resultToMcpContent(result)).toThrow(/Error \(signal SIGTERM\):/);
  });
});
