/**
 * Audit record honesty — verifies the approval section in audit records
 * reflects the real ApprovalDecision returned by gateApproval, not the
 * old yoloApproval(now) placeholder.
 *
 * Goes through executeAuditedTransportCommand which is the test seam for
 * the auditExecution() path used by the production exec/sudo-exec handlers.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { AuditStore, activeFilePath } from '../store.js';
import { ExecResult, ISshTransport } from '../../transports/types.js';

describe('audit record approval truth', () => {
  it('threads a real smart-mode ApprovalDecision into the audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-audit-truth-'));
    try {
      process.env.SSH_MCP_DISABLE_MAIN = '1';
      const { executeAuditedTransportCommand } = await import('../../index.js');
      const store = new AuditStore({ auditDir: dir, auditMaxBytes: 1024 });

      const transport: Pick<ISshTransport, 'exec' | 'execElevated'> = {
        exec: async (): Promise<ExecResult> => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
        execElevated: async (): Promise<ExecResult> => { throw new Error('unused'); },
      };

      // Simulate a SmartApproval-shaped decision (no placeholder).
      await executeAuditedTransportCommand({
        transport,
        store,
        tool: 'exec',
        profile: 'prod',
        command: 'uptime',
        approval: {
          decision: 'allow',
          reason: 'LLM allowed: routine read',
          decided_by: 'smart-llm',
          decided_at: new Date('2026-01-01T00:00:00Z').toISOString(),
          mode: 'smart',
        },
      });

      const file = activeFilePath(dir);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const rec = JSON.parse(lines[0]);

      // Audit record must reflect the actual decision — NOT the yolo placeholder.
      expect(rec.approval.mode).toBe('smart');
      expect(rec.approval.decision).toBe('allow');
      expect(rec.approval.decided_by).toBe('smart-llm');
      expect(rec.approval.reason).toBe('LLM allowed: routine read');
      expect(rec.approval.reason).not.toContain('yolo placeholder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads a real manual-mode ApprovalDecision into the audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-audit-truth-'));
    try {
      process.env.SSH_MCP_DISABLE_MAIN = '1';
      const { executeAuditedTransportCommand } = await import('../../index.js');
      const store = new AuditStore({ auditDir: dir, auditMaxBytes: 1024 });
      const transport: Pick<ISshTransport, 'exec' | 'execElevated'> = {
        exec: async (): Promise<ExecResult> => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
        execElevated: async (): Promise<ExecResult> => { throw new Error('unused'); },
      };
      await executeAuditedTransportCommand({
        transport,
        store,
        tool: 'exec',
        profile: 'prod',
        command: 'whoami',
        approval: {
          decision: 'allow',
          reason: 'looks safe',
          decided_by: 'webui:alice',
          decided_at: new Date().toISOString(),
          mode: 'manual',
        },
      });
      const rec = JSON.parse(readFileSync(activeFilePath(dir), 'utf8').trim());
      expect(rec.approval.mode).toBe('manual');
      expect(rec.approval.decided_by).toBe('webui:alice');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to yolo placeholder only when no approval is threaded (legacy path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-audit-truth-'));
    try {
      process.env.SSH_MCP_DISABLE_MAIN = '1';
      const { executeAuditedTransportCommand } = await import('../../index.js');
      const store = new AuditStore({ auditDir: dir, auditMaxBytes: 1024 });
      const transport: Pick<ISshTransport, 'exec' | 'execElevated'> = {
        exec: async (): Promise<ExecResult> => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
        execElevated: async (): Promise<ExecResult> => { throw new Error('unused'); },
      };
      await executeAuditedTransportCommand({
        transport,
        store,
        tool: 'exec',
        profile: 'prod',
        command: 'uptime',
        // no approval — legacy/placeholder path
      });
      const rec = JSON.parse(readFileSync(activeFilePath(dir), 'utf8').trim());
      expect(rec.approval.mode).toBe('yolo');
      expect(rec.approval.decided_by).toBe('yolo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
