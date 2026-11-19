import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetConsumedPositionsForTests,
  isCompletedWaitTimer,
  isNoopDelivery,
  isTerminalRun,
  recordCompletedWait,
  recordConsumedPosition,
  recordTerminalRun,
} from './consumed-position.js';
import {
  DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS,
  getInlineStepDeadlineMarginMs,
  mayStartInlineStep,
} from './deadline.js';
import {
  DEFAULT_ORCHESTRATOR_HOOK_LINGER_MS,
  DEFAULT_ORCHESTRATOR_LINGER_MS,
  getOrchestratorHookLingerMs,
  getOrchestratorLingerMsFor,
  getOrchestratorWaitLingerMs,
  LingerTimes,
  lingerKindOf,
  ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
  orchestratorLingerUntil,
} from './live-feed.js';
import {
  analyzeLogSteps,
  awaitsExternalWork,
  externalWorkOf,
} from './log-state.js';
import {
  MAX_STEP_MESSAGE_RETENTION_SECONDS,
  retryOutlivesMessage,
  STEP_RETRY_EXPIRY_SLACK_SECONDS,
  stepMessageRetentionSeconds,
} from './step-retention.js';

const world = {} as never;
afterEach(() => __resetConsumedPositionsForTests(world));

describe('step message retention', () => {
  it('gives a retrying step the queue maximum', () => {
    expect(stepMessageRetentionSeconds(3)).toBe(
      MAX_STEP_MESSAGE_RETENTION_SECONDS
    );
    expect(stepMessageRetentionSeconds(0)).toBeLessThan(
      MAX_STEP_MESSAGE_RETENTION_SECONDS
    );
  });

  it('fails a retry that would land after the message expires', () => {
    const createdAt = new Date(0);
    const retention = MAX_STEP_MESSAGE_RETENTION_SECONDS;
    const lastSafeMs = (retention - STEP_RETRY_EXPIRY_SLACK_SECONDS) * 1000;
    expect(
      retryOutlivesMessage({
        messageCreatedAt: createdAt,
        retentionSeconds: retention,
        retryAtMs: lastSafeMs,
      })
    ).toBe(false);
    expect(
      retryOutlivesMessage({
        messageCreatedAt: createdAt,
        retentionSeconds: retention,
        retryAtMs: lastSafeMs + 1,
      })
    ).toBe(true);
    expect(
      retryOutlivesMessage({
        messageCreatedAt: undefined,
        retentionSeconds: retention,
        retryAtMs: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(false);
  });
});

describe('inline step deadline', () => {
  it('stops starting inline steps inside the margin', () => {
    const marginMs = getInlineStepDeadlineMarginMs({});
    expect(marginMs).toBe(DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS);
    const deadlineMs = 10 * marginMs;
    expect(
      mayStartInlineStep({
        nowMs: deadlineMs - marginMs - 1,
        deadlineMs,
        marginMs,
      })
    ).toBe(true);
    expect(
      mayStartInlineStep({ nowMs: deadlineMs - marginMs, deadlineMs, marginMs })
    ).toBe(false);
    expect(
      mayStartInlineStep({ nowMs: 0, deadlineMs: undefined, marginMs })
    ).toBe(true);
    expect(
      getInlineStepDeadlineMarginMs({
        WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS: '5',
      })
    ).toBe(5);
  });
});

describe('cheap no-op deliveries', () => {
  it('skips a delivery whose tail is the consumed position and has no due timer', () => {
    recordConsumedPosition(world, 'wrun_a', { slot: 7, nextTimerAtMs: 2_000 });
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 7, nowMs: 1_000 })
    ).toBe(true);
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 8, nowMs: 1_000 })
    ).toBe(false);
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 7, nowMs: 2_000 })
    ).toBe(false);
    expect(
      isNoopDelivery({ world, runId: 'wrun_b', tailSlot: 7, nowMs: 0 })
    ).toBe(false);
  });
});

describe('inline steps in the log', () => {
  let slot = 0;
  const event = (
    eventType: string,
    eventData: Record<string, unknown> = {}
  ): Event =>
    ({
      eventType,
      correlationId: 'step_a',
      eventId: `evnt_${String(++slot).padStart(26, '0')}`,
      runId: 'wrun_a',
      createdAt: new Date(slot * 1000),
      eventData: { stepName: 'a', ...eventData },
    }) as unknown as Event;
  const inlineStart = () =>
    event('step_started', { attempt: 1, inline: true, workflowName: 'w' });

  it('runs an open inline step again in the orchestrator', () => {
    const [step] = analyzeLogSteps([inlineStart()]);
    expect(step).toMatchObject({ starts: 1, runnableInline: true });
  });

  it('leaves an inline step to its own message once it retried, after its next start too', () => {
    const retried = [inlineStart(), event('step_retrying', { attempt: 1 })];
    expect(analyzeLogSteps(retried)[0]?.runnableInline).toBe(false);
    const restarted = [...retried, event('step_started', { attempt: 2 })];
    expect(analyzeLogSteps(restarted)[0]).toMatchObject({
      starts: 2,
      lastIsRetrying: false,
      runnableInline: false,
    });
    // The same rule as the run's external work.
    expect(awaitsExternalWork(restarted)).toBe(true);
    expect(externalWorkOf(restarted)).toBe('step');
  });
});

describe('linger windows', () => {
  let slot = 0;
  const event = (
    eventType: string,
    correlationId: string,
    eventData: Record<string, unknown> = {}
  ): Event =>
    ({
      eventType,
      correlationId,
      eventId: `evnt_${String(++slot).padStart(26, '0')}`,
      runId: 'wrun_a',
      createdAt: new Date(slot * 1000),
      eventData,
    }) as unknown as Event;
  const hook = () => event('hook_created', 'hook_a', { token: 't' });
  const background = () => event('step_created', 'step_b', { stepName: 'b' });

  it('classifies what the run waits on, a background step over a hook', () => {
    expect(externalWorkOf([])).toBeUndefined();
    expect(externalWorkOf([hook()])).toBe('hook');
    expect(
      externalWorkOf([hook(), event('hook_disposed', 'hook_a')])
    ).toBeUndefined();
    expect(externalWorkOf([background()])).toBe('step');
    expect(externalWorkOf([hook(), background()])).toBe('step');
    expect(
      externalWorkOf([
        hook(),
        background(),
        event('step_completed', 'step_b', { result: 1 }),
      ])
    ).toBe('hook');
  });

  it('lingers on hooks alone for the hook window, never past the full window of a background step', () => {
    expect(getOrchestratorLingerMsFor('hook', {})).toBe(
      Math.min(
        DEFAULT_ORCHESTRATOR_HOOK_LINGER_MS,
        DEFAULT_ORCHESTRATOR_LINGER_MS
      )
    );
    expect(getOrchestratorLingerMsFor('step', {})).toBe(
      DEFAULT_ORCHESTRATOR_LINGER_MS
    );
    expect(getOrchestratorLingerMsFor(undefined, {})).toBe(0);
  });

  it('reads the hook window from its own setting, capped by the linger', () => {
    expect(
      getOrchestratorHookLingerMs({
        WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: '200',
      })
    ).toBe(200);
    expect(
      getOrchestratorHookLingerMs({ WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: '0' })
    ).toBe(0);
    expect(
      getOrchestratorHookLingerMs({ WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: 'x' })
    ).toBe(
      Math.min(
        DEFAULT_ORCHESTRATOR_HOOK_LINGER_MS,
        DEFAULT_ORCHESTRATOR_LINGER_MS
      )
    );
    // Never longer than the linger, and off with it.
    expect(
      getOrchestratorHookLingerMs({ WORKFLOW_ORCHESTRATOR_LINGER_MS: '1000' })
    ).toBe(1_000);
    expect(
      getOrchestratorHookLingerMs({
        WORKFLOW_ORCHESTRATOR_LINGER_MS: '0',
        WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: '5000',
      })
    ).toBe(0);
    expect(
      getOrchestratorHookLingerMs({
        WORKFLOW_ORCHESTRATOR_LINGER_MS: '60000',
        WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: '20000',
      })
    ).toBe(20_000);
  });
});

describe('external work: open hooks', () => {
  const created = (correlationId: string, token: string): Event =>
    ({
      eventType: 'hook_created',
      correlationId,
      eventId: `evnt_${correlationId}`,
      runId: 'wrun_a',
      createdAt: new Date(0),
      eventData: { token },
    }) as unknown as Event;
  const completion = created('hook_c', 'wkf_child_run_completion:wrun_a');
  const user = created('hook_u', 'approval');

  it('counts an open user hook whether or not it is awaited', () => {
    expect(awaitsExternalWork([user], new Set())).toBe(true);
  });

  it('counts the completion hook only while a child is awaited', () => {
    expect(awaitsExternalWork([completion], new Set())).toBe(false);
    expect(awaitsExternalWork([completion], new Set(['hook_c']))).toBe(true);
    // No observation recorded (QuickJS): every open hook counts.
    expect(awaitsExternalWork([completion])).toBe(true);
  });
});

describe('linger through near-due waits', () => {
  const nowMs = 1_000_000;
  const windowMs = DEFAULT_ORCHESTRATOR_LINGER_MS;
  const capMs = nowMs + 100 * windowMs;

  it('reads the wait window from its own setting, capped by the linger', () => {
    expect(getOrchestratorWaitLingerMs({})).toBe(
      DEFAULT_ORCHESTRATOR_LINGER_MS
    );
    expect(
      getOrchestratorWaitLingerMs({ WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: '0' })
    ).toBe(0);
    expect(
      getOrchestratorWaitLingerMs({ WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: 'x' })
    ).toBe(DEFAULT_ORCHESTRATOR_LINGER_MS);
    expect(
      getOrchestratorWaitLingerMs({
        WORKFLOW_ORCHESTRATOR_LINGER_MS: '60000',
        WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: '10000',
      })
    ).toBe(10_000);
    // Never longer than the linger at its default.
    expect(
      getOrchestratorWaitLingerMs({
        WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: String(
          2 * DEFAULT_ORCHESTRATOR_LINGER_MS
        ),
      })
    ).toBe(DEFAULT_ORCHESTRATOR_LINGER_MS);
    expect(
      getOrchestratorWaitLingerMs({
        WORKFLOW_ORCHESTRATOR_LINGER_MS: '1000',
        WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: '10000',
      })
    ).toBe(1_000);
    expect(
      getOrchestratorWaitLingerMs({ WORKFLOW_ORCHESTRATOR_LINGER_MS: '0' })
    ).toBe(0);
  });

  it('lingers until a wait due within the window, past the deadline never', () => {
    const waitInMs = windowMs / 2;
    expect(
      orchestratorLingerUntil(
        { work: undefined, nextWaitAtMs: nowMs + waitInMs, nowMs, capMs },
        {}
      )
    ).toEqual({
      untilMs: nowMs + waitInMs + ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
      forWait: true,
    });
    // Due past the window, beyond the slack.
    expect(
      orchestratorLingerUntil(
        {
          work: undefined,
          nextWaitAtMs:
            nowMs + windowMs + ORCHESTRATOR_WAIT_LINGER_SLACK_MS + 1,
          nowMs,
          capMs,
        },
        {}
      )
    ).toBeUndefined();
    // Due past the inline deadline less its margin.
    expect(
      orchestratorLingerUntil(
        {
          work: undefined,
          nextWaitAtMs: nowMs + waitInMs,
          nowMs,
          capMs: nowMs + waitInMs - 1,
        },
        {}
      )
    ).toBeUndefined();
    // Off.
    expect(
      orchestratorLingerUntil(
        { work: undefined, nextWaitAtMs: nowMs + waitInMs, nowMs, capMs },
        { WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS: '0' }
      )
    ).toBeUndefined();
    // No wait, no external work.
    expect(
      orchestratorLingerUntil(
        { work: undefined, nextWaitAtMs: undefined, nowMs, capMs },
        {}
      )
    ).toBeUndefined();
  });

  // A sleep as long as the window lingers, even when the deadline the
  // workflow computed is a little ahead of this host's clock, or the
  // suspend decision comes a few ms after the `wait_created`.
  it('lingers for a wait due exactly one window ahead, and within the slack past it', () => {
    for (const aheadMs of [
      windowMs - 5,
      windowMs,
      windowMs + 5,
      windowMs + ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
    ]) {
      expect(
        orchestratorLingerUntil(
          { work: undefined, nextWaitAtMs: nowMs + aheadMs, nowMs, capMs },
          {}
        )
      ).toEqual({
        untilMs: nowMs + aheadMs + ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
        forWait: true,
      });
    }
  });

  it('takes the later of the external window and the wait, capped', () => {
    const hookMs = DEFAULT_ORCHESTRATOR_HOOK_LINGER_MS;
    // A wait due after the hook window extends the linger to it.
    expect(
      orchestratorLingerUntil(
        { work: 'hook', nextWaitAtMs: nowMs + 2 * hookMs, nowMs, capMs },
        {
          WORKFLOW_ORCHESTRATOR_LINGER_MS: String(4 * hookMs),
          WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS: String(hookMs),
        }
      )
    ).toEqual({
      untilMs: nowMs + 2 * hookMs + ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
      forWait: true,
    });
    // A wait due within the step window keeps the step window.
    expect(
      orchestratorLingerUntil(
        { work: 'step', nextWaitAtMs: nowMs + 1, nowMs, capMs },
        {}
      )
    ).toEqual(
      windowMs >= 1 + ORCHESTRATOR_WAIT_LINGER_SLACK_MS
        ? { untilMs: nowMs + windowMs, forWait: false }
        : {
            untilMs: nowMs + 1 + ORCHESTRATOR_WAIT_LINGER_SLACK_MS,
            forWait: true,
          }
    );
    // The deadline caps the slack.
    expect(
      orchestratorLingerUntil(
        {
          work: undefined,
          nextWaitAtMs: nowMs + 1_000,
          nowMs,
          capMs: nowMs + 1_000,
        },
        {}
      )
    ).toEqual({ untilMs: nowMs + 1_000, forWait: true });
  });
});

describe('leftover timers of completed waits', () => {
  const world = {} as never;
  afterEach(() => __resetConsumedPositionsForTests(world));

  it('knows the final timer of a wait this process completed', () => {
    recordCompletedWait(world, 'wrun_a', 'wait_1');
    expect(
      isCompletedWaitTimer(world, 'wrun_a', { correlationId: 'wait_1' })
    ).toBe(true);
    // An intermediate hop still sends the next hop.
    expect(
      isCompletedWaitTimer(world, 'wrun_a', {
        correlationId: 'wait_1',
        resumeAtMs: 1,
      })
    ).toBe(false);
    expect(
      isCompletedWaitTimer(world, 'wrun_a', { correlationId: 'wait_2' })
    ).toBe(false);
    expect(
      isCompletedWaitTimer(world, 'wrun_b', { correlationId: 'wait_1' })
    ).toBe(false);
  });

  it('treats every delivery of a run that ended here as a no-op', () => {
    recordConsumedPosition(world, 'wrun_a', { slot: 4 });
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 5, nowMs: 0 })
    ).toBe(false);
    recordTerminalRun(world, 'wrun_a');
    expect(isTerminalRun(world, 'wrun_a')).toBe(true);
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 5, nowMs: 0 })
    ).toBe(true);
  });
});

describe('linger telemetry', () => {
  it('names what a linger was taken for', () => {
    expect(lingerKindOf({ forWait: true }, 'step')).toBe('wait');
    expect(lingerKindOf({ forWait: false }, 'step')).toBe('step');
    expect(lingerKindOf({ forWait: false }, 'hook')).toBe('hook');
  });

  it('keeps a total per kind across the lingers of one delivery', () => {
    const times = new LingerTimes();
    times.add('wait', 300);
    times.add('step', 50);
    expect(times.add('wait', 200)).toEqual({
      'workflow.linger.wait_ms': 500,
      'workflow.linger.step_ms': 50,
      'workflow.linger.hook_ms': 0,
    });
  });
});
