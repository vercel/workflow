import { describe, expect, it } from 'vitest';
import {
  ActorInvariantError,
  type ActorSnapshot,
  assertActorSnapshot,
} from './actor-execution.js';
import { projectActorSnapshot } from './actor-projection.js';

function snapshot(): ActorSnapshot {
  const at = new Date('2026-01-01T00:00:00Z');
  return {
    profile: 'actor-owner-v1',
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

describe('actor-owner-v1 journal contract', () => {
  it('loads a dense committed prefix without changing it', () => {
    const s = snapshot();
    const original = structuredClone(s);
    expect(projectActorSnapshot(s).run.deploymentId).toBe('dpl_test');
    expect(s).toEqual(original);
  });
  it('rejects holes instead of normalizing the log', () => {
    const s = snapshot();
    s.events[0].eventId = `evnt_${'2'.padStart(26, '0')}`;
    expect(() => assertActorSnapshot(s)).toThrow(ActorInvariantError);
  });
  it('rejects a changed deployment and a persisted quarantine', () => {
    const s = snapshot();
    s.deploymentId = 'dpl_wrong';
    expect(() => assertActorSnapshot(s)).toThrow(/immutable deployment/);
    const stopped = snapshot();
    stopped.fault = {
      code: 'ACTOR_INVARIANT_VIOLATION',
      message: 'two writers',
    };
    expect(() => projectActorSnapshot(stopped)).toThrow('two writers');
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
    expect(() => projectActorSnapshot(s)).toThrow(/step lifecycle/);
  });
});
