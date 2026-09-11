import { describe, expect, it } from 'vitest';
import {
  assertExecutionSnapshot,
  ExecutionInvariantError,
  type ExecutionSnapshot,
} from './execution.js';
import { projectExecutionSnapshot } from './execution-projection.js';

function snapshot(): ExecutionSnapshot {
  const at = new Date('2026-01-01T00:00:00Z');
  return {
    profile: 'single-owner-v1',
    runId: 'wrun_test',
    deploymentId: 'dpl_test',
    head: 1,
    tenant: {
      ownerId: 'team_test',
      projectId: 'prj_test',
      environment: 'preview',
    },
    events: [
      {
        runId: 'wrun_test',
        eventId: `evnt_${'1'.padStart(26, '0')}`,
        createdAt: at,
        eventType: 'run_created',
        specVersion: 7,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'workflow//test//main',
          input: new Uint8Array(),
        },
      },
    ],
  };
}

describe('single-owner-v1 journal contract', () => {
  it('loads a dense committed prefix without changing it', () => {
    const s = snapshot();
    const original = structuredClone(s);
    expect(projectExecutionSnapshot(s).run.deploymentId).toBe('dpl_test');
    expect(s).toEqual(original);
  });
  it('rejects holes instead of normalizing the log', () => {
    const s = snapshot();
    s.events[0].eventId = `evnt_${'2'.padStart(26, '0')}`;
    expect(() => assertExecutionSnapshot(s)).toThrow(ExecutionInvariantError);
  });
  it('rejects a changed deployment and a persisted quarantine', () => {
    const s = snapshot();
    s.deploymentId = 'dpl_wrong';
    expect(() => assertExecutionSnapshot(s)).toThrow(/immutable deployment/);
    const stopped = snapshot();
    stopped.fault = {
      code: 'EXECUTION_INVARIANT_VIOLATION',
      message: 'two writers',
    };
    expect(() => projectExecutionSnapshot(stopped)).toThrow('two writers');
  });
  it('does not accept lifecycle completion without creation', () => {
    const s = snapshot();
    s.head++;
    s.events.push({
      eventId: `evnt_${'2'.padStart(26, '0')}`,
      runId: s.runId,
      createdAt: new Date(),
      eventType: 'step_completed',
      correlationId: 'step_missing',
      eventData: { result: new Uint8Array() },
    });
    expect(() => projectExecutionSnapshot(s)).toThrow(/step lifecycle/);
  });
});
