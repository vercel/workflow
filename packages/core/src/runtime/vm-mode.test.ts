import { WorkflowRuntimeError } from '@workflow/errors';
import type { WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSnapshotThreshold,
  getSnapshotThresholdFromEnv,
  getWorkflowVmFromEnv,
  useQuickJSVm,
  WORKFLOW_VMS,
} from './vm-mode.js';

describe('getWorkflowVmFromEnv', () => {
  it('returns undefined when WORKFLOW_VM is not set', () => {
    expect(getWorkflowVmFromEnv({})).toBeUndefined();
  });

  it('returns undefined when WORKFLOW_VM is empty', () => {
    expect(getWorkflowVmFromEnv({ WORKFLOW_VM: '' })).toBeUndefined();
  });

  it('returns "node" when WORKFLOW_VM=node', () => {
    expect(getWorkflowVmFromEnv({ WORKFLOW_VM: 'node' })).toBe('node');
  });

  it('returns "quickjs" when WORKFLOW_VM=quickjs', () => {
    expect(getWorkflowVmFromEnv({ WORKFLOW_VM: 'quickjs' })).toBe('quickjs');
  });

  it('throws WorkflowRuntimeError on unknown values', () => {
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: 'bogus' })).toThrow(
      WorkflowRuntimeError
    );
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: 'bogus' })).toThrow(
      /Invalid WORKFLOW_VM value: "bogus"/
    );
  });

  it('is case-sensitive: uppercase values are rejected', () => {
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: 'QUICKJS' })).toThrow(
      WorkflowRuntimeError
    );
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: 'Node' })).toThrow(
      WorkflowRuntimeError
    );
  });

  it('rejects leading/trailing whitespace', () => {
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: ' quickjs' })).toThrow(
      WorkflowRuntimeError
    );
    expect(() => getWorkflowVmFromEnv({ WORKFLOW_VM: 'node ' })).toThrow(
      WorkflowRuntimeError
    );
  });

  it('error message lists valid options', () => {
    try {
      getWorkflowVmFromEnv({ WORKFLOW_VM: 'bogus' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRuntimeError);
      for (const mode of WORKFLOW_VMS) {
        expect((err as Error).message).toContain(mode);
      }
    }
  });
});

describe('useQuickJSVm', () => {
  const makeRun = (executionContext?: Record<string, unknown>) =>
    ({
      runId: 'wrun_test',
      workflowName: 'test',
      executionContext,
    }) as unknown as WorkflowRun;

  afterEach(() => {
    delete process.env.WORKFLOW_VM;
  });

  it('defaults to QuickJS (true) when nothing is configured', () => {
    expect(useQuickJSVm(makeRun())).toBe(true);
  });

  it('an empty WORKFLOW_VM value also resolves to the QuickJS default', () => {
    process.env.WORKFLOW_VM = '';
    expect(useQuickJSVm(makeRun())).toBe(true);
  });

  it('returns true when WORKFLOW_VM=quickjs is set in the environment', () => {
    process.env.WORKFLOW_VM = 'quickjs';
    expect(useQuickJSVm(makeRun())).toBe(true);
  });

  it('returns false when WORKFLOW_VM=node is set in the environment', () => {
    process.env.WORKFLOW_VM = 'node';
    expect(useQuickJSVm(makeRun())).toBe(false);
  });

  it('executionContext.workflowVm=quickjs wins over env node', () => {
    process.env.WORKFLOW_VM = 'node';
    expect(useQuickJSVm(makeRun({ workflowVm: 'quickjs' }))).toBe(true);
  });

  it('executionContext.workflowVm=node wins over env quickjs (run affinity)', () => {
    process.env.WORKFLOW_VM = 'quickjs';
    expect(useQuickJSVm(makeRun({ workflowVm: 'node' }))).toBe(false);
  });

  it('throws on unknown executionContext.workflowVm values', () => {
    expect(() => useQuickJSVm(makeRun({ workflowVm: 'bogus' }))).toThrow(
      WorkflowRuntimeError
    );
  });

  it('throws on unknown WORKFLOW_VM env values', () => {
    process.env.WORKFLOW_VM = 'bogus';
    expect(() => useQuickJSVm(makeRun())).toThrow(WorkflowRuntimeError);
  });
});

describe('getSnapshotThresholdFromEnv', () => {
  it('returns undefined when unset or empty', () => {
    expect(getSnapshotThresholdFromEnv({})).toBeUndefined();
    expect(
      getSnapshotThresholdFromEnv({ WORKFLOW_SNAPSHOT_THRESHOLD: '' })
    ).toBeUndefined();
  });

  it('parses non-negative integers', () => {
    expect(
      getSnapshotThresholdFromEnv({ WORKFLOW_SNAPSHOT_THRESHOLD: '0' })
    ).toBe(0);
    expect(
      getSnapshotThresholdFromEnv({ WORKFLOW_SNAPSHOT_THRESHOLD: '1' })
    ).toBe(1);
    expect(
      getSnapshotThresholdFromEnv({ WORKFLOW_SNAPSHOT_THRESHOLD: '250' })
    ).toBe(250);
  });

  it('throws on invalid values', () => {
    for (const bad of ['-1', '1.5', 'abc', 'Infinity']) {
      expect(() =>
        getSnapshotThresholdFromEnv({ WORKFLOW_SNAPSHOT_THRESHOLD: bad })
      ).toThrow(WorkflowRuntimeError);
    }
  });
});

describe('getSnapshotThreshold', () => {
  const makeRun = (executionContext?: Record<string, unknown>) =>
    ({
      runId: 'wrun_test',
      workflowName: 'test',
      executionContext,
    }) as unknown as WorkflowRun;

  afterEach(() => {
    delete process.env.WORKFLOW_SNAPSHOT_THRESHOLD;
  });

  it('defaults to 0 (disabled)', () => {
    expect(getSnapshotThreshold(makeRun())).toBe(0);
  });

  it('reads the env var when the run has no stamped policy', () => {
    process.env.WORKFLOW_SNAPSHOT_THRESHOLD = '100';
    expect(getSnapshotThreshold(makeRun())).toBe(100);
  });

  it('executionContext.snapshotThreshold wins over env (run affinity)', () => {
    process.env.WORKFLOW_SNAPSHOT_THRESHOLD = '100';
    expect(getSnapshotThreshold(makeRun({ snapshotThreshold: 5 }))).toBe(5);
    expect(getSnapshotThreshold(makeRun({ snapshotThreshold: 0 }))).toBe(0);
  });

  it('throws on invalid stamped values', () => {
    expect(() =>
      getSnapshotThreshold(makeRun({ snapshotThreshold: -1 }))
    ).toThrow(WorkflowRuntimeError);
    expect(() =>
      getSnapshotThreshold(makeRun({ snapshotThreshold: 'x' }))
    ).toThrow(WorkflowRuntimeError);
  });
});
