import { describe, expect, it } from 'vitest';
import type { VersionBacklog } from '../backlog-handler.js';
import {
  type PrunePlanInput,
  planPrune,
  type WorkerDeployment,
} from './plan.js';

const HOUR = 3_600_000;
const now = new Date('2026-11-13T00:00:00Z');

const worker = (version: string, ageMs = 2 * HOUR): WorkerDeployment => ({
  name: `svc-wf-${version}`,
  version,
  createdAt: new Date(now.getTime() - ageMs),
});

const backlog = (
  version: string,
  activeRuns: number,
  dueDeliveries = 0
): VersionBacklog => ({
  version,
  activeRuns,
  dueDeliveries,
  wanted: activeRuns > 0 ? dueDeliveries : 0,
});

const base = (overrides: Partial<PrunePlanInput>): PrunePlanInput => ({
  now,
  workers: [],
  protectedVersions: new Set(),
  backlogs: new Map(),
  activeVersions: new Map(),
  minAgeMs: HOUR,
  ...overrides,
});

describe('planPrune', () => {
  it('deletes a drained version and keeps the rest for their reasons', () => {
    const workers = [
      'current',
      'rolling',
      'fresh',
      'busy',
      'unknown',
      'drained',
    ].map((v) => worker(v, v === 'fresh' ? 60_000 : 2 * HOUR));
    const actions = planPrune(
      base({
        workers,
        protectedVersions: new Set(['current', 'rolling']),
        backlogs: new Map<string, VersionBacklog | Error>([
          ['busy', backlog('busy', 3, 1)],
          ['unknown', new Error('timeout')],
          ['drained', backlog('drained', 0, 2)],
        ]),
        activeVersions: new Map([['busy', 3]]),
      })
    );
    expect(
      actions.map((a) =>
        a.kind === 'restore'
          ? a
          : [a.kind, a.worker.version, 'reason' in a ? a.reason : undefined]
      )
    ).toEqual([
      ['keep', 'current', 'protected'],
      ['keep', 'rolling', 'protected'],
      ['keep', 'fresh', 'young'],
      ['keep', 'busy', 'active-runs'],
      ['keep', 'unknown', 'backlog-unavailable'],
      ['delete', 'drained', undefined],
    ]);
  });

  it('restores workers for a version with unfinished runs and none running', () => {
    expect(
      planPrune(
        base({
          activeVersions: new Map([
            ['orphaned', 2],
            ['finished', 0],
          ]),
        })
      )
    ).toEqual([{ kind: 'restore', version: 'orphaned', activeRuns: 2 }]);
  });

  it('restores nothing when the active versions cannot be listed', () => {
    expect(planPrune(base({ activeVersions: new Error('db down') }))).toEqual(
      []
    );
  });

  // Every combination of what can be known about one version's workers.
  const backlogs = {
    missing: undefined,
    error: new Error('unavailable'),
    drained: backlog('v', 0, 1),
    busy: backlog('v', 2, 1),
  } as const;
  const activeLists = {
    error: new Error('unavailable'),
    without: new Map([['other', 1]]),
    zero: new Map([['v', 0]]),
    active: new Map([['v', 2]]),
  } as const;
  const cases = [true, false].flatMap((isProtected) =>
    [true, false].flatMap((young) =>
      (Object.keys(backlogs) as (keyof typeof backlogs)[]).flatMap((b) =>
        (Object.keys(activeLists) as (keyof typeof activeLists)[]).map((a) => ({
          isProtected,
          young,
          b,
          a,
        }))
      )
    )
  );

  it.each(
    cases
  )('deletes only a version that is unprotected, old enough, readable and drained (%o)', ({
    isProtected,
    young,
    b,
    a,
  }) => {
    const backlogValue = backlogs[b];
    const actions = planPrune(
      base({
        workers: [worker('v', young ? 60_000 : 2 * HOUR)],
        protectedVersions: new Set(isProtected ? ['v'] : []),
        backlogs: new Map(
          backlogValue === undefined ? [] : [['v', backlogValue]]
        ),
        activeVersions: activeLists[a],
      })
    );
    const deletable =
      !isProtected &&
      !young &&
      b === 'drained' &&
      a !== 'error' &&
      a !== 'active';
    expect(actions.filter((x) => x.kind === 'delete')).toHaveLength(
      deletable ? 1 : 0
    );
    // A version with workers is never restored.
    expect(actions.some((x) => x.kind === 'restore' && x.version === 'v')).toBe(
      false
    );
  });

  it('repairs a kept worker that lost its ScaledObject', () => {
    const actions = planPrune(
      base({
        workers: [worker('busy'), worker('scaled')],
        scalers: [worker('scaled')],
        backlogs: new Map([
          ['busy', backlog('busy', 1)],
          ['scaled', backlog('scaled', 1)],
        ]),
        activeVersions: new Map([
          ['busy', 1],
          ['scaled', 1],
        ]),
      })
    );
    expect(actions.filter((a) => a.kind === 'repair')).toEqual([
      { kind: 'repair', worker: worker('busy') },
    ]);
  });

  it('deletes a drained version’s ScaledObject left without its worker, and keeps a busy one’s', () => {
    const actions = planPrune(
      base({
        scalers: [worker('drained'), worker('busy'), worker('fresh', 60_000)],
        activeVersions: new Map([['busy', 2]]),
      })
    );
    expect(actions).toEqual([
      { kind: 'restore', version: 'busy', activeRuns: 2 },
      { kind: 'delete-scaler', scaler: worker('drained') },
    ]);
  });

  it('keeps an orphaned ScaledObject when the active versions cannot be listed', () => {
    const actions = planPrune(
      base({ scalers: [worker('drained')], activeVersions: new Error('down') })
    );
    expect(actions).toEqual([]);
  });
});
