import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmbiguousCommitError } from '@workflow/errors';
import {
  type BatchEventRequest,
  type CommitEventsResult,
  type Event,
  PIGGYBACK_HELD_EVENT_ID,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  slotToEventId,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSuspension } from '../global.js';
import { countStepStartedEvents } from './count-step-started-events.js';
import {
  findEventSlotGap,
  maxEventSlot,
  slotSnapshotParams,
} from './helpers.js';
import {
  denseTop,
  EVE_WORKFLOW_ENTRY,
  type HeldExecution,
  isEveSubagentRun,
  ownIdsAbove,
  type PiggybackChainContext,
  type PiggybackReplayOutcome,
  piggybackHoldIneligibleReason,
  piggybackPreSendExitReason,
  piggybackUnavailableReason,
  resetPiggybackCommitMemoForTests,
  runPiggybackChain,
  syntheticHeldEvent,
  verifyCommittedRows,
} from './piggyback.js';
import type { StepExecutionResult } from './step-executor.js';

const RUN_ID = 'wrun_piggyback_unit';
const T0 = new Date('2026-09-28T00:00:00.000Z');

const ev = (
  slot: number,
  eventType: string,
  correlationId?: string,
  eventData: Record<string, unknown> = {}
): Event =>
  ({
    eventId: slotToEventId(slot),
    runId: RUN_ID,
    eventType,
    ...(correlationId ? { correlationId } : {}),
    specVersion: SPEC_VERSION_CURRENT,
    createdAt: new Date(T0.getTime() + slot),
    eventData,
  }) as unknown as Event;

/** run_created, run_started, created(A), started(A): the prefix through 2. */
const prefix = () => [ev(1, 'run_created'), ev(2, 'run_started')];
const ownTailA = () => [
  ev(3, 'step_created', 'step_a', { stepName: 'a' }),
  ev(4, 'step_started', 'step_a', { stepName: 'a', ownerMessageId: 'msg' }),
];

beforeEach(() => {
  resetPiggybackCommitMemoForTests();
  vi.stubEnv('WORKFLOW_PIGGYBACK_COMMIT', '1');
  vi.stubEnv('WORKFLOW_PIGGYBACK_RUN_END', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the held completion never reaches a slot helper', () => {
  const synthetic = syntheticHeldEvent(RUN_ID, {
    eventType: 'step_completed',
    correlationId: 'step_a',
    stepName: 'a',
    eventData: { result: new Uint8Array([1]) },
    occurredAt: T0,
    heldAtMs: 0,
  });

  it('carries the sentinel id and the time the commit stores verbatim', () => {
    expect(synthetic.eventId).toBe(PIGGYBACK_HELD_EVENT_ID);
    expect(synthetic.createdAt).toBe(T0);
    expect(synthetic.eventType).toBe('step_completed');
  });

  it('is refused by name by every positional helper', () => {
    expect(() => requireEventSlot(synthetic.eventId)).toThrow(
      /held \(not yet durable\) step completion/
    );
    const log = [...prefix(), synthetic];
    expect(() => maxEventSlot(log)).toThrow(/held/);
    expect(() => slotSnapshotParams(log)).toThrow(/held/);
    expect(() => findEventSlotGap(log)).toThrow(/held/);
  });

  it('is not an `own` id, and never counts as a position', () => {
    const input = [...prefix(), ...ownTailA(), synthetic];
    expect(ownIdsAbove(input, 2)).toEqual([slotToEventId(3), slotToEventId(4)]);
  });
});

describe('denseTop', () => {
  it('is the top of the dense prefix from slot 1', () => {
    expect(denseTop([...prefix(), ...ownTailA()])).toBe(4);
    expect(denseTop([ev(1, 'run_created'), ev(2, 'x'), ev(4, 'y')])).toBe(2);
  });
  it('refuses a log that does not start at slot 1', () => {
    expect(denseTop([ev(2, 'run_started')])).toBeUndefined();
    expect(denseTop([])).toBeUndefined();
  });
});

describe('own is computed from the replay input', () => {
  it('leaves out a sibling acknowledged during the hold but not replayed', () => {
    // A sibling's completion at slot 5 was acknowledged to this process while
    // A's completion was held, but the replay never consumed it: it must fence
    // the commit, not be exempted from it (OwnFromAcks).
    const replayInput = [...prefix(), ...ownTailA()];
    const acknowledgedSibling = ev(5, 'step_completed', 'step_sibling');
    const own = ownIdsAbove(replayInput, 2);
    expect(own).not.toContain(acknowledgedSibling.eventId);
    expect(own).toEqual([slotToEventId(3), slotToEventId(4)]);
  });
});

describe('piggybackUnavailableReason', () => {
  const world = (commit?: unknown, createBatch: unknown = vi.fn()) =>
    ({ events: { commit, createBatch } }) as unknown as World;
  it('requires a flag, the World method, and a sealed log', () => {
    const commit = vi.fn();
    // `commit` without `createBatch`: the chain's first claim is a batch pair.
    expect(
      piggybackUnavailableReason(world(commit, null), {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBe('world_unsupported');
    expect(
      piggybackUnavailableReason(world(commit), {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBeUndefined();
    expect(
      piggybackUnavailableReason(world(undefined), {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBe('world_unsupported');
    expect(
      piggybackUnavailableReason(world(commit), {
        specVersion: (SPEC_VERSION_SUPPORTS_SEALED_LOG - 1) as never,
      })
    ).toBe('spec_version');
    vi.stubEnv('WORKFLOW_PIGGYBACK_COMMIT', '0');
    vi.stubEnv('WORKFLOW_PIGGYBACK_RUN_END', '');
    expect(
      piggybackUnavailableReason(world(commit), {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBe('disabled');
  });

  it('keeps eve subagent runs off piggyback (the server depth gate runs only on the lazy start)', () => {
    const commit = vi.fn();
    const base = { specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG };
    expect(
      piggybackUnavailableReason(world(commit), {
        ...base,
        workflowName: EVE_WORKFLOW_ENTRY,
        attributes: { '$eve.type': 'subagent' },
      })
    ).toBe('eve_subagent');
    // A top-level eve run, or a subagent attribute on another workflow, is
    // outside the server's gate and stays eligible.
    expect(
      piggybackUnavailableReason(world(commit), {
        ...base,
        workflowName: EVE_WORKFLOW_ENTRY,
        attributes: {},
      })
    ).toBeUndefined();
    expect(
      piggybackUnavailableReason(world(commit), {
        ...base,
        workflowName: 'workflow//app//main',
        attributes: { '$eve.type': 'subagent' },
      })
    ).toBeUndefined();
    expect(
      isEveSubagentRun({
        workflowName: EVE_WORKFLOW_ENTRY,
        attributes: { '$eve.type': 'subagent' },
      })
    ).toBe(true);
  });

  it('defaults both flags off', () => {
    vi.unstubAllEnvs();
    delete process.env.WORKFLOW_PIGGYBACK_COMMIT;
    delete process.env.WORKFLOW_PIGGYBACK_RUN_END;
    expect(
      piggybackUnavailableReason(world(vi.fn()), {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBe('disabled');
  });
});

describe('piggybackHoldIneligibleReason', () => {
  const claim = {
    owned: true as const,
    step: {} as never,
    events: ownTailA(),
  };
  const base = {
    unavailableReason: undefined,
    prefixLoaded: true,
    inlineExecutions: 1,
    requestInlineDelta: true,
    forceOptimisticStart: false,
    preclaimedStart: claim,
  };
  it.each([
    [{}, undefined],
    [{ inlineExecutions: 2 }, 'siblings'],
    [{ prefixLoaded: false }, 'turbo_synth_prefix'],
    [{ forceOptimisticStart: true }, 'optimistic_start'],
    [{ requestInlineDelta: false }, 'not_sequential'],
    [{ preclaimedStart: undefined }, 'not_preclaimed'],
    [{ preclaimedStart: { owned: false as const } }, 'not_preclaimed'],
    [{ preclaimedStart: { ...claim, events: undefined } }, 'own_rows_unknown'],
    [{ unavailableReason: 'spec_version' }, 'spec_version'],
  ])('%o → %s', (overrides, expected) => {
    expect(
      piggybackHoldIneligibleReason({ ...base, ...overrides } as never)
    ).toBe(expected);
  });
});

describe('piggybackPreSendExitReason', () => {
  const quiet = {
    replayBudgetExhausted: false,
    elapsedMs: 10,
    inlineReplayLimitMs: 1000,
    activityRevision: 3,
    iterationRevision: 3,
  };
  it('lets a quiet iteration send', () => {
    expect(piggybackPreSendExitReason(quiet)).toBeUndefined();
    expect(
      piggybackPreSendExitReason({ ...quiet, activityRevision: undefined })
    ).toBeUndefined();
  });
  it('stops on the budget, the timeout, and a channel notice', () => {
    expect(
      piggybackPreSendExitReason({ ...quiet, replayBudgetExhausted: true })
    ).toBe('replay_budget');
    expect(piggybackPreSendExitReason({ ...quiet, elapsedMs: 1000 })).toBe(
      'invocation_timeout'
    );
    // A run input arrived since the iteration read its log: a foreign event
    // above `after` the fence would reject for sure.
    expect(piggybackPreSendExitReason({ ...quiet, activityRevision: 4 })).toBe(
      'channel_moved'
    );
  });
});

describe('verifyCommittedRows', () => {
  const T1 = new Date('2026-09-28T00:00:01.000Z');
  const sent: BatchEventRequest[] = [
    {
      event: {
        eventType: 'step_completed',
        correlationId: 'step_a',
        eventData: { result: new Uint8Array() },
      } as never,
      occurredAt: T0,
    },
    {
      event: { eventType: 'run_completed', eventData: {} } as never,
      occurredAt: T1,
    },
  ];
  const answer = (
    overrides: Partial<
      Extract<CommitEventsResult, { status: 'committed' }>
    > = {}
  ): Extract<CommitEventsResult, { status: 'committed' }> => ({
    status: 'committed',
    results: [
      {
        event: {
          ...ev(5, 'step_completed', 'step_a'),
          createdAt: T0,
        } as Event,
      },
      { event: { ...ev(6, 'run_completed'), createdAt: T1 } as Event },
    ],
    denseThrough: 6,
    cursor: 'c6',
    ...overrides,
  });
  it('accepts a matching answer', () => {
    expect(verifyCommittedRows(sent, answer(), 4)).toBeUndefined();
  });
  it('catches a clamped timestamp', () => {
    const bad = answer();
    bad.results[0] = {
      event: { ...bad.results[0].event, createdAt: T1 } as Event,
    };
    expect(verifyCommittedRows(sent, bad, 4)).toBe('row_0_created_at');
  });
  it('catches a gap between rows, a stale denseThrough, and a wrong step', () => {
    const gap = answer();
    gap.results[1] = {
      event: { ...ev(7, 'run_completed'), createdAt: T1 } as Event,
    };
    expect(verifyCommittedRows(sent, gap, 4)).toBe('row_1_slot');
    expect(verifyCommittedRows(sent, answer({ denseThrough: 7 }), 4)).toBe(
      'dense_through'
    );
    const wrongStep = answer();
    wrongStep.results[0] = {
      event: {
        ...ev(5, 'step_completed', 'step_other'),
        createdAt: T0,
      } as Event,
    };
    expect(verifyCommittedRows(sent, wrongStep, 4)).toBe('row_0_correlation');
    expect(verifyCommittedRows(sent, answer(), 5)).toBe('row_0_slot');
  });
});

// ---------------------------------------------------------------------------
// The chain, against a scripted loop context
// ---------------------------------------------------------------------------

interface Harness {
  ctx: PiggybackChainContext;
  /** Every externally visible effect, in order. */
  effects: string[];
  commit: ReturnType<typeof vi.fn>;
  heldA: HeldExecution;
  flushA: ReturnType<typeof vi.fn>;
}

function heldResult(
  correlationId: string,
  flush: () => Promise<StepExecutionResult>,
  occurredAt = T0
): Extract<StepExecutionResult, { type: 'held' }> {
  return {
    type: 'held',
    held: {
      eventType: 'step_completed',
      correlationId,
      stepName: correlationId,
      eventData: { stepName: correlationId, result: new Uint8Array([7]) },
      occurredAt,
      heldAtMs: Date.now(),
    },
    flushAlone: flush,
  };
}

const suspensionStub = {
  items: [{ type: 'step', correlationId: 'step_b', stepName: 'b' }],
} as unknown as WorkflowSuspension;

/** A committed step-pair answer for the harness's request. */
function committedStepPair(request: {
  after: number;
  own: string[];
  events: BatchEventRequest[];
}): CommitEventsResult {
  const first = request.after + request.own.length + 1;
  return {
    status: 'committed',
    results: request.events.map((event, i) => ({
      event: {
        eventId: slotToEventId(first + i),
        runId: RUN_ID,
        eventType: event.event.eventType,
        correlationId: event.event.correlationId,
        createdAt: event.occurredAt,
        eventData: {},
      } as unknown as Event,
      ...(event.event.eventType === 'step_started'
        ? {
            step: {
              runId: RUN_ID,
              stepId: 'step_b',
              stepName: 'b',
              status: 'running' as const,
              attempt: 1,
              createdAt: T0,
              updatedAt: T0,
              startedAt: T0,
            },
          }
        : {}),
    })),
    denseThrough: first + request.events.length - 1,
    cursor: `cursor_${first + request.events.length - 1}`,
  };
}

function harness(
  overrides: {
    replay?: PiggybackReplayOutcome | Error;
    stepPair?: Awaited<ReturnType<PiggybackChainContext['buildStepPair']>>;
    runFailure?: Awaited<ReturnType<PiggybackChainContext['buildRunFailure']>>;
    preSend?: string;
    commit?: (request: {
      after: number;
      own: string[];
      events: BatchEventRequest[];
    }) => Promise<CommitEventsResult>;
    eventLog?: Event[];
    ownTail?: Event[];
    ownerMessageId?: string | undefined;
    runStep?: () => Promise<StepExecutionResult>;
  } = {}
): Harness {
  const effects: string[] = [];
  const commit = vi.fn(async (_runId: string, request: never) => {
    effects.push('commit');
    return (overrides.commit ?? (async (r) => committedStepPair(r)))(request);
  });
  const flushA = vi.fn(async (): Promise<StepExecutionResult> => {
    effects.push('flush:step_a');
    return {
      type: 'completed',
      hasPendingOps: false,
      inlineDelta: { events: [], cursor: 'delta', hasMore: false },
    };
  });
  const inFlight = new Set(['step_a']);
  const ctx: PiggybackChainContext = {
    runId: RUN_ID,
    world: { events: { commit, createBatch: vi.fn() } } as unknown as World,
    ownerMessageId:
      'ownerMessageId' in overrides ? overrides.ownerMessageId : 'msg',
    eventLog: {
      events: overrides.eventLog ?? prefix(),
      cursor: 'cursor_2',
    },
    inFlightOwnedSteps: inFlight,
    replay: vi.fn(async () => {
      effects.push('replay');
      const outcome = overrides.replay ?? {
        type: 'suspended' as const,
        suspension: suspensionStub,
      };
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    discardReplay: vi.fn(() => {
      effects.push('discard');
    }),
    retainAfterCommit: vi.fn(),
    rekeyHeldEvent: vi.fn(),
    buildStepPair: vi.fn(
      async () =>
        overrides.stepPair ?? {
          eligible: true as const,
          correlationId: 'step_b',
          stepName: 'b',
          dehydratedInput: new Uint8Array([9]),
          events: [
            {
              eventType: 'step_created',
              correlationId: 'step_b',
              eventData: { stepName: 'b', input: new Uint8Array([9]) },
            } as never,
            {
              eventType: 'step_started',
              correlationId: 'step_b',
              eventData: { stepName: 'b', ownerMessageId: 'msg' },
            } as never,
          ],
          serializationBlockerCount: 0,
        }
    ),
    buildRunFailure: vi.fn(async () => overrides.runFailure),
    onRunCompleted: vi.fn(() => {
      effects.push('run_completed_hooks');
    }),
    preSendExitReason: vi.fn(() => overrides.preSend),
    mayHoldNext: vi.fn(() => false),
    runStep: vi.fn(async () => {
      effects.push('run:step_b');
      return overrides.runStep
        ? overrides.runStep()
        : { type: 'completed' as const, hasPendingOps: false };
    }),
  };
  return {
    ctx,
    effects,
    commit,
    flushA,
    heldA: {
      correlationId: 'step_a',
      stepName: 'step_a',
      result: heldResult('step_a', flushA),
      ownTail: overrides.ownTail ?? ownTailA(),
    },
  };
}

describe('runPiggybackChain: a committed step pair', () => {
  it('commits [completed(A), created(B), started(B)] and only then runs B', async () => {
    const h = harness();
    const outcome = await runPiggybackChain(h.ctx, h.heldA);
    expect(h.effects).toEqual(['replay', 'commit', 'run:step_b']);
    expect(h.flushA).not.toHaveBeenCalled();
    const [, request] = h.commit.mock.calls[0];
    expect(request.after).toBe(2);
    expect(request.own).toEqual([slotToEventId(3), slotToEventId(4)]);
    expect(
      request.events.map((e: BatchEventRequest) => e.event.eventType)
    ).toEqual(['step_completed', 'step_created', 'step_started']);
    expect(request.events[0].occurredAt).toBe(T0);
    // The confirmed rows joined the log, the synthetic renamed in place.
    expect(
      h.ctx.eventLog.events.map((e) => requireEventSlot(e.eventId))
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(h.ctx.eventLog.cursor).toBe('cursor_7');
    expect(h.ctx.rekeyHeldEvent).toHaveBeenCalledWith(slotToEventId(5));
    expect(outcome).toEqual({
      type: 'step',
      correlationId: 'step_b',
      stepName: 'b',
      result: { type: 'completed', hasPendingOps: false },
    });
    // B ran off the pair's verdict, born running with its input attached.
    const next = vi.mocked(h.ctx.runStep).mock.calls[0][0];
    expect(next.preclaimedStart.owned).toBe(true);
    expect(next.preclaimedStart.source).toBe('piggyback');
    expect(next.preclaimedStart.step.input).toEqual(new Uint8Array([9]));
    // No owned execution is left counted once the chain settles.
    expect(h.ctx.inFlightOwnedSteps.size).toBe(0);
  });

  it('counts the held completion as in flight until it is durable', async () => {
    let inFlightAtCommit: string[] = [];
    const h = harness({
      commit: async (request) => {
        inFlightAtCommit = [...h.ctx.inFlightOwnedSteps];
        return committedStepPair(request);
      },
    });
    await runPiggybackChain(h.ctx, h.heldA);
    expect(inFlightAtCommit).toEqual(['step_a']);
  });

  it('leaves the log alone when the World sealed gap positions', async () => {
    const h = harness({
      commit: async (request) => {
        // The World sealed a gap position (a noop the client never read), so
        // the pair landed one slot higher than the client's contiguous view.
        const shifted = committedStepPair({
          ...request,
          own: [...request.own, 'gap'],
        });
        return shifted;
      },
    });
    await runPiggybackChain(h.ctx, h.heldA);
    expect(h.ctx.eventLog.events).toHaveLength(2);
    expect(h.ctx.eventLog.cursor).toBe('cursor_2');
    expect(h.ctx.discardReplay).toHaveBeenCalled();
    expect(vi.mocked(h.ctx.runStep).mock.calls[0][0].holdTerminal).toBe(false);
  });

  it('continues the chain while each step’s completion is held', async () => {
    const flushB = vi.fn(
      async (): Promise<StepExecutionResult> => ({
        type: 'completed',
      })
    );
    let step = 0;
    const h = harness({
      runStep: async () => {
        step++;
        return step === 1
          ? heldResult('step_b', flushB, new Date(T0.getTime() + 10))
          : { type: 'completed', hasPendingOps: false };
      },
    });
    let replays = 0;
    vi.mocked(h.ctx.replay).mockImplementation(async () => {
      replays++;
      h.effects.push('replay');
      return replays === 1
        ? { type: 'suspended', suspension: suspensionStub }
        : { type: 'completed', output: 'done' };
    });
    vi.mocked(h.ctx.mayHoldNext).mockReturnValue(true);
    h.commit.mockImplementation(async (_runId: string, request: never) => {
      h.effects.push('commit');
      const r = request as {
        after: number;
        own: string[];
        events: BatchEventRequest[];
      };
      if (r.events.length === 3) return committedStepPair(r);
      const first = r.after + 1;
      return {
        status: 'committed',
        results: r.events.map((e, i) => ({
          event: {
            eventId: slotToEventId(first + i),
            runId: RUN_ID,
            eventType: e.event.eventType,
            correlationId: e.event.correlationId,
            createdAt: e.occurredAt,
            eventData: {},
          } as unknown as Event,
        })),
        denseThrough: first + 1,
        cursor: 'c',
      };
    });
    const outcome = await runPiggybackChain(h.ctx, h.heldA);
    expect(h.effects).toEqual([
      'replay',
      'commit',
      'run:step_b',
      'replay',
      'commit',
      'run_completed_hooks',
    ]);
    expect(outcome).toEqual({ type: 'run_finished' });
    // B's commit fenced from the top of the extended log, with no own tail.
    const [, second] = h.commit.mock.calls[1];
    expect(second.after).toBe(7);
    expect(second.own).toEqual([]);
    expect(flushB).not.toHaveBeenCalled();
  });
});

/**
 * Every exit a hold can take, and the one contract all of them share
 * (FlushOnExit): the held completion is written alone before any other write,
 * and the replay that consumed the synthetic completion is discarded. Nothing
 * after the exit runs B.
 */
describe('runPiggybackChain: every exit flushes first and discards the replay', () => {
  const cases: Array<{
    name: string;
    setup: Parameters<typeof harness>[0];
    reason: string;
    reread?: boolean;
    committed?: boolean;
  }> = [
    {
      name: 'a log that is not a dense prefix',
      setup: { eventLog: [ev(2, 'run_started')] },
      reason: 'prefix_not_dense',
    },
    {
      name: 'an own tail below the prefix',
      setup: { eventLog: [...prefix(), ...ownTailA()] },
      reason: 'own_below_prefix',
    },
    {
      name: 'a replay that throws',
      setup: { replay: new Error('compile failed') },
      reason: 'replay_error',
    },
    {
      name: 'a suspension that is not one new step',
      setup: { stepPair: { eligible: false, reason: 'shape_hook' } },
      reason: 'shape_hook',
    },
    {
      name: 'no ownership stamp for B',
      setup: { ownerMessageId: undefined },
      reason: 'no_owner_message',
    },
    {
      name: 'a finished run with a pending end-of-run drain',
      setup: { replay: { type: 'completed', output: 1 } },
      reason: 'end_of_run_drain',
    },
    {
      name: 'a run failure that is not a user error',
      setup: { replay: { type: 'failed', error: new Error('x') } },
      reason: 'run_failed_not_user_error',
    },
    {
      name: 'a pre-send budget or timeout exit',
      setup: { preSend: 'invocation_timeout' },
      reason: 'invocation_timeout',
    },
    {
      name: 'a fence rejection',
      setup: {
        commit: async () => ({
          status: 'rejected',
          reason: 'fence',
          conflictSlot: 3,
        }),
      },
      reason: 'rejected_fence',
      committed: true,
    },
    {
      name: 'an unsupported route',
      setup: {
        commit: async () => ({
          status: 'rejected',
          reason: 'unsupported',
          unsupportedForMs: 600_000,
        }),
      },
      reason: 'rejected_unsupported',
      committed: true,
    },
    {
      name: 'an ambiguous commit',
      setup: {
        commit: async () => {
          throw new AmbiguousCommitError('lost');
        },
      },
      reason: 'ambiguous',
      reread: true,
      committed: true,
    },
    {
      name: 'any other commit failure',
      setup: {
        commit: async () => {
          throw new Error('boom');
        },
      },
      reason: 'commit_error',
      reread: true,
      committed: true,
    },
  ];

  it.each(cases)('$name → $reason', async ({
    setup,
    reason,
    reread,
    committed,
  }) => {
    const h = harness(setup);
    if (reason === 'end_of_run_drain') {
      vi.mocked(h.ctx.replay).mockImplementation(async (_events, hold) => {
        h.effects.push('replay');
        hold.drainPending = true;
        return { type: 'completed', output: 1 };
      });
    }
    const outcome = await runPiggybackChain(h.ctx, h.heldA);
    // The only write before the flush is (at most) the commit that was
    // refused; nothing derived from the synthetic view got out.
    const firstWrite = h.effects.findIndex(
      (effect) => effect === 'flush:step_a' || effect.startsWith('run:')
    );
    expect(h.effects[firstWrite]).toBe('flush:step_a');
    expect(h.effects.filter((e) => e === 'commit')).toHaveLength(
      committed ? 1 : 0
    );
    expect(h.effects).not.toContain('run:step_b');
    expect(h.effects).toContain('discard');
    expect(h.flushA).toHaveBeenCalledTimes(1);
    expect(outcome.type).toBe('step');
    if (outcome.type !== 'step') throw new Error('unreachable');
    expect(outcome.correlationId).toBe('step_a');
    // An ambiguous exit must re-read: the flush's delta is dropped.
    if (reread) {
      expect(outcome.result).toMatchObject({ type: 'completed' });
      expect(
        (outcome.result as { inlineDelta?: unknown }).inlineDelta
      ).toBeUndefined();
    } else {
      expect(
        (outcome.result as { inlineDelta?: unknown }).inlineDelta
      ).toBeDefined();
    }
    expect(h.ctx.inFlightOwnedSteps.has('step_a')).toBe(false);
  });

  it('remembers an unsupported World so the next hold is skipped', async () => {
    const h = harness({
      commit: async () => ({
        status: 'rejected',
        reason: 'unsupported',
        unsupportedForMs: 600_000,
      }),
    });
    await runPiggybackChain(h.ctx, h.heldA);
    expect(
      piggybackUnavailableReason(h.ctx.world, {
        specVersion: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      })
    ).toBe('route_unsupported');
  });

  it('a verification mismatch runs nothing, flushes nothing, and re-reads', async () => {
    const h = harness({
      commit: async (request) => {
        const answer = committedStepPair(request);
        if (answer.status !== 'committed') throw new Error('unreachable');
        answer.results[0] = {
          event: {
            ...answer.results[0].event,
            createdAt: new Date(T0.getTime() + 1),
          },
        };
        return answer;
      },
    });
    const outcome = await runPiggybackChain(h.ctx, h.heldA);
    expect(h.effects).toEqual(['replay', 'commit', 'discard']);
    expect(outcome).toEqual({
      type: 'step',
      correlationId: 'step_a',
      stepName: 'step_a',
      result: { type: 'completed' },
    });
    expect(h.ctx.eventLog.events).toHaveLength(2);
  });

  it('an ambiguous pair plus one owned recovery stays under the retry ceiling', () => {
    // The pair may have landed with this delivery's stamp on started(B); the
    // re-read then drives owned recovery, whose attempt is this message's
    // starts + 1. One ambiguous pair must leave room for that recovery under
    // the default ceiling (maxRetries 3 → attempts 1..4).
    const log = [
      ...prefix(),
      ...ownTailA(),
      ev(5, 'step_completed', 'step_a'),
      ev(6, 'step_created', 'step_b', { stepName: 'b' }),
      ev(7, 'step_started', 'step_b', { stepName: 'b', ownerMessageId: 'msg' }),
    ];
    const attempt =
      countStepStartedEvents(log, 'step_b', {
        type: 'ownedBy',
        messageId: 'msg',
      }) + 1;
    expect(attempt).toBe(2);
    expect(attempt).toBeLessThanOrEqual(3 + 1);
  });
});

/**
 * The exit enumeration, as a lint over the source: before the commit is sent,
 * every `return` in `commitHeld` must go through the exit (`return exit(`);
 * after it, only the verified-commit paths return, and none of them after the
 * runStep call can flush. A new early return that forgets the flush fails
 * here, which is the NoFlushOnExit counterfactual the model pins.
 */
describe('exit enumeration (source lint)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'piggyback.ts'), 'utf8');
  const fn = (name: string) => {
    const from = source.indexOf(`async function ${name}(`);
    expect(from).toBeGreaterThan(0);
    const to = source.indexOf('\n}\n', from);
    return source.slice(from, to);
  };
  const returnsOf = (body: string) =>
    (body.match(/\breturn\b[^;]*/g) ?? []).map((r) => r.replace(/\s+/g, ' '));

  it('planning names an exit or returns a plan, and writes nothing', () => {
    const body = fn('planCommit');
    const returns = returnsOf(body);
    expect(returns.length).toBeGreaterThanOrEqual(8);
    for (const statement of returns) {
      expect(statement).toMatch(/^return \{ (exit: |request: )/);
    }
    expect(body).not.toMatch(/flushAlone|commit\.call|runStep/);
  });

  it('every return of a hold before a committed answer is an exit', () => {
    const body = fn('commitHeld');
    const returns = returnsOf(body);
    const last = returns.pop();
    expect(last).toMatch(/^return continueAfterCommit\(/);
    expect(returns.length).toBeGreaterThanOrEqual(6);
    for (const statement of returns) {
      expect(statement).toMatch(/^return exit\(/);
    }
  });

  it('nothing after a committed answer flushes or exits', () => {
    const body = fn('continueAfterCommit');
    expect(body).not.toMatch(/flushAlone|exitWithHeld|\bexit\(/);
  });

  it('the hold replays the run’s own code, and a missing script is an exit', () => {
    const runtime = readFileSync(join(here, '..', 'runtime.ts'), 'utf8');
    const from = runtime.indexOf('replay: async (events, drainHold)');
    expect(from).toBeGreaterThan(0);
    const body = runtime.slice(from, runtime.indexOf('discardReplay:', from));
    // The same code source as the main replay (a dynamic run's stored code).
    expect(body).toMatch(/workflowCode: effectiveWorkflowCode/);
    expect(body).toMatch(/\?\?\s+dynamicWorkflowScripts/);
    // The script assertion sits before the catch that turns a throw into the
    // workflow's own failure (which a run-end pair would commit).
    const assertAt = body.indexOf(
      "'Node workflow replay requires compiled scripts'"
    );
    const catchAt = body.indexOf('} catch (error) {');
    expect(assertAt).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(assertAt);
    // Engines and runs the hold never serves.
    expect(runtime).toMatch(
      /if \(useQuickJSVm\(workflowRun\)\) return 'quickjs';/
    );
    expect(runtime).toMatch(
      /if \(dynamicWorkflowMetadata\) return 'dynamic_workflow';/
    );
  });

  it('the runtime hands every held result to the chain', () => {
    const runtime = readFileSync(join(here, '..', 'runtime.ts'), 'utf8');
    const holdSites = runtime.match(/holdTerminal:/g) ?? [];
    // The inline batch's execution and the chain's own `runStep`.
    expect(holdSites).toHaveLength(2);
    expect(runtime).toMatch(
      /if \(executed\.type !== 'held'\) return executed;\s+const outcome = await runHeldChain\(s, executed\);/
    );
  });
});
