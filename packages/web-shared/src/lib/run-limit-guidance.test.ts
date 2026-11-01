import { describe, expect, it } from 'vitest';
import {
  getRunLimitGuidance,
  isQuickJSSnapshotRun,
} from './run-limit-guidance';

const failed = (errorCode: string, extra: Record<string, unknown> = {}) => ({
  status: 'failed',
  errorCode,
  ...extra,
});

describe('getRunLimitGuidance', () => {
  it('returns null for missing, non-failed, and unrelated runs', () => {
    expect(getRunLimitGuidance(undefined)).toBeNull();
    expect(getRunLimitGuidance(null)).toBeNull();
    expect(
      getRunLimitGuidance({
        status: 'running',
        errorCode: 'MAX_EVENTS_EXCEEDED',
      })
    ).toBeNull();
    expect(getRunLimitGuidance(failed('USER_ERROR'))).toBeNull();
    expect(getRunLimitGuidance({ status: 'failed' })).toBeNull();
  });

  it('recommends WORKFLOW_VM=quickjs for node runs that hit the event limit', () => {
    const guidance = getRunLimitGuidance(failed('MAX_EVENTS_EXCEEDED'));
    expect(guidance).toMatchObject({
      kind: 'max-events-exceeded',
      envVar: 'WORKFLOW_VM=quickjs',
      docsUrl: 'https://workflow-sdk.dev/err/max-events-exceeded',
    });
    expect(
      getRunLimitGuidance(failed('MAX_EVENTS_EXCEEDED', { workflowVm: 'node' }))
        ?.envVar
    ).toBe('WORKFLOW_VM=quickjs');
  });

  it('recommends QuickJS for replay timeouts', () => {
    expect(getRunLimitGuidance(failed('REPLAY_TIMEOUT'))).toMatchObject({
      kind: 'replay-timeout',
      envVar: 'WORKFLOW_VM=quickjs',
      docsUrl: 'https://workflow-sdk.dev/err/replay-timeout',
    });
  });

  it('suggests a snapshot threshold for QuickJS runs without one', () => {
    for (const extra of [
      { workflowVm: 'quickjs' },
      { workflowVm: 'quickjs', snapshotThreshold: 0 },
    ]) {
      const guidance = getRunLimitGuidance(
        failed('MAX_EVENTS_EXCEEDED', extra)
      );
      expect(guidance?.envVar).toBe('WORKFLOW_SNAPSHOT_THRESHOLD=1000');
      expect(guidance?.description).toContain('QuickJS');
    }
  });

  it('returns null for runs already on QuickJS with snapshotting', () => {
    const hydrated = { workflowVm: 'quickjs', snapshotThreshold: 1000 };
    expect(
      getRunLimitGuidance(failed('MAX_EVENTS_EXCEEDED', hydrated))
    ).toBeNull();
    expect(getRunLimitGuidance(failed('REPLAY_TIMEOUT', hydrated))).toBeNull();
    // Raw (unhydrated) runs carry the policy in executionContext.
    expect(
      getRunLimitGuidance(
        failed('MAX_EVENTS_EXCEEDED', { executionContext: hydrated })
      )
    ).toBeNull();
  });
});

describe('isQuickJSSnapshotRun', () => {
  it('requires the QuickJS VM and a positive safe-integer threshold', () => {
    expect(
      isQuickJSSnapshotRun({ workflowVm: 'quickjs', snapshotThreshold: 1 })
    ).toBe(true);
    expect(isQuickJSSnapshotRun({ workflowVm: 'quickjs' })).toBe(false);
    expect(
      isQuickJSSnapshotRun({ workflowVm: 'quickjs', snapshotThreshold: 1.5 })
    ).toBe(false);
    expect(
      isQuickJSSnapshotRun({ workflowVm: 'node', snapshotThreshold: 1000 })
    ).toBe(false);
    expect(isQuickJSSnapshotRun({})).toBe(false);
  });
});
