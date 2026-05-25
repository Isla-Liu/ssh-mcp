/**
 * Approval engine entry point.
 *
 * Resolves the effective mode (per-source override > global default) and
 * dispatches to yolo / smart / manual. Returned ApprovalDecision is meant to
 * be appended verbatim into the audit record's `approval` block.
 */

import {
  ApprovalContext,
  ApprovalDecision,
  ApprovalEngine,
  ApprovalMode,
  ManualApprovalOptions,
  PendingApproval,
  SmartApprovalOptions,
} from './types.js';
import { YoloApproval } from './yolo.js';
import { SmartApproval } from './smart.js';
import { ManualApproval } from './manual.js';

export interface BuildApprovalEngineOptions {
  /** Default approval mode when a source has no [sources.approval] override. */
  defaultMode: ApprovalMode;
  /** Smart-mode config; required when defaultMode or any per-source override uses smart. */
  smart?: SmartApprovalOptions;
  /** Manual-mode config; required when defaultMode or any per-source override uses manual. */
  manual?: ManualApprovalOptions;
}

/**
 * Dispatch engine that owns one instance per mode. Lazy-builds per-mode
 * engines so a yolo-only deployment never has to configure smart or manual.
 */
export class ApprovalDispatcher implements ApprovalEngine {
  private readonly yolo = new YoloApproval();
  private readonly smart?: SmartApproval;
  private readonly manual?: ManualApproval;

  constructor(private readonly opts: BuildApprovalEngineOptions) {
    if (opts.smart) {
      this.smart = new SmartApproval(opts.smart);
    }
    if (opts.manual) {
      // Construction itself enforces the WebUI-required invariant.
      this.manual = new ManualApproval(opts.manual);
    }
    // Eager validate: default mode must have its engine wired.
    this.requireEngineFor(opts.defaultMode);
  }

  private requireEngineFor(mode: ApprovalMode): ApprovalEngine {
    switch (mode) {
      case 'yolo':
        return this.yolo;
      case 'smart':
        if (!this.smart) {
          throw new Error(`approval mode "smart" requested but [approval.llm] is not configured`);
        }
        return this.smart;
      case 'manual':
        if (!this.manual) {
          throw new Error(`approval mode "manual" requested but WebUI/manual options are not configured`);
        }
        return this.manual;
      default: {
        const exhaustive: never = mode;
        throw new Error(`unknown approval mode: ${exhaustive}`);
      }
    }
  }

  async decide(ctx: ApprovalContext): Promise<ApprovalDecision> {
    const effective = ctx.profile.approval?.mode ?? this.opts.defaultMode;
    const engine = this.requireEngineFor(effective);
    return engine.decide(ctx);
  }

  listPending(): PendingApproval[] {
    return this.manual?.listPending() ?? [];
  }

  resolvePending(id: string, decision: 'allow' | 'deny', note?: string, decided_by?: string): boolean {
    if (!this.manual) return false;
    return this.manual.resolvePending(id, decision, note, decided_by);
  }
}

/** Convenience builder mirroring dbhub's factory style. */
export function buildApprovalEngine(opts: BuildApprovalEngineOptions): ApprovalDispatcher {
  return new ApprovalDispatcher(opts);
}
