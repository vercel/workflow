import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import type { QueueItem, WorkflowSuspension } from '../global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { runWorkflow } from '../workflow.js';
import { observeOutOfBandWriters } from './out-of-band-observation.js';

describe('observeOutOfBandWriters', () => {
  const hook = (correlationId: string, extra: object = {}): QueueItem => ({
    type: 'hook',
    correlationId,
    token: correlationId,
    hasCreatedEvent: true,
    ...extra,
  });
  const step = (correlationId: string): QueueItem => ({
    type: 'step',
    correlationId,
    stepName: 's',
    args: [],
  });
  const observe = (
    items: QueueItem[],
    overrides: Partial<Parameters<typeof observeOutOfBandWriters>[0]> = {}
  ) =>
    observeOutOfBandWriters({
      items,
      observedHookIds: new Set(),
      selfExecutedStepIds: new Set(['inline']),
      waitDue: false,
      ...overrides,
    });

  it('is inert with only unobserved hooks and self-executed steps', () => {
    const result = observe([hook('h1'), hook('h2'), step('inline')]);
    expect(result).toMatchObject({ unobservedHookCount: 2, inert: true });
  });

  it('is not inert when a hook has a waiting consumer', () => {
    const result = observe([hook('h1'), hook('h2')], {
      observedHookIds: new Set(['h2']),
    });
    expect(result).toMatchObject({
      observedHookCount: 1,
      unobservedHookCount: 1,
      inert: false,
    });
  });

  it('treats every open hook as observed without awaiter tracking', () => {
    const result = observe([hook('h1')], { observedHookIds: undefined });
    expect(result).toMatchObject({ unknownHookCount: 1, inert: false });
  });

  it('treats an AbortController system hook as observed', () => {
    const result = observe([hook('abrt', { isSystem: true })]);
    expect(result).toMatchObject({ abortSignalHookCount: 1, inert: false });
  });

  it('ignores a hook this suspension disposes', () => {
    const result = observe([hook('h1', { disposed: true })], {
      observedHookIds: undefined,
    });
    expect(result.inert).toBe(true);
  });

  it('is not inert while a step runs in another executor', () => {
    const result = observe([step('inline'), step('elsewhere')]);
    expect(result).toMatchObject({ externalStepCount: 1, inert: false });
  });

  it('is not inert when an open wait is due', () => {
    expect(observe([], { waitDue: true }).inert).toBe(false);
  });
});

const RUN_ID = 'wrun_out_of_band_observation';
const T0 = Date.parse('2024-01-01T00:00:00.000Z');
const PRELUDE = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const a = useStep("a");
  const b = useStep("b");
`;
const TRANSFORM = `;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

async function makeRun(): Promise<WorkflowRun> {
  const ops: Promise<unknown>[] = [];
  const input = await dehydrateWorkflowArguments([], RUN_ID, undefined, ops);
  await Promise.all(ops);
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    startedAt: new Date(T0),
    deploymentId: 'test-deployment',
  };
}

async function dehydrate(value: unknown) {
  const ops: Promise<unknown>[] = [];
  const result = await dehydrateStepReturnValue(value, RUN_ID, undefined, ops);
  await Promise.all(ops);
  return result;
}

/** Replays `events` and returns the suspension, or `undefined` on completion. */
async function replay(
  code: string,
  events: Event[]
): Promise<WorkflowSuspension | undefined> {
  try {
    await runWorkflow(
      PRELUDE + code + TRANSFORM,
      await makeRun(),
      events,
      undefined
    );
    return undefined;
  } catch (error) {
    if ((error as Error).name !== 'WorkflowSuspension') throw error;
    return error as WorkflowSuspension;
  }
}

let eventSeq = 0;
function event(
  eventType: Event['eventType'],
  correlationId: string,
  eventData: object,
  createdAtMs: number
): Event {
  return {
    eventId: `evnt_${String(++eventSeq).padStart(6, '0')}`,
    runId: RUN_ID,
    eventType,
    correlationId,
    eventData: eventData as Event['eventData'],
    createdAt: new Date(createdAtMs),
  };
}

/**
 * Drives `code` as the only writer: every replay's new hooks and steps are
 * created, every step completes with a result naming its arguments, every
 * wait completes ahead of the steps created alongside it (so a `sleep` wins
 * any race against them), and each
 * suspension that asks for nothing new is answered with the next of
 * `payloads` for the run's one hook. Returns the log and the hook's id.
 */
async function singleWriterLog(code: string, payloads: unknown[]) {
  const events: Event[] = [];
  let at = T0;
  const tick = () => {
    at += 10;
    return at;
  };
  let hookId = '';
  for (let iteration = 0; iteration < 50; iteration++) {
    const suspension = await replay(code, events);
    if (!suspension) return { events, hookId };
    const fresh = suspension.items.filter((item) => !item.hasCreatedEvent);
    if (fresh.length === 0) {
      const payload = payloads.shift();
      if (payload === undefined) return { events, hookId };
      events.push(
        event(
          'hook_received',
          hookId,
          { payload: await dehydrate(payload) },
          tick()
        )
      );
      continue;
    }
    // Steps last, so their completions land after any wait's.
    const ordered = [
      ...fresh.filter((item) => item.type !== 'step'),
      ...fresh.filter((item) => item.type === 'step'),
    ];
    for (const item of ordered) {
      if (item.type === 'wait') {
        events.push(
          event(
            'wait_created',
            item.correlationId,
            { resumeAt: item.resumeAt },
            tick()
          ),
          event('wait_completed', item.correlationId, {}, tick())
        );
      } else if (item.type === 'hook') {
        hookId = item.correlationId;
        events.push(
          event(
            'hook_created',
            item.correlationId,
            { token: item.token, isWebhook: false },
            tick()
          )
        );
      } else if (item.type === 'step') {
        events.push(
          event(
            'step_created',
            item.correlationId,
            { stepName: item.stepName },
            tick()
          ),
          event(
            'step_completed',
            item.correlationId,
            {
              stepName: item.stepName,
              result: await dehydrate(
                `${item.stepName}(${JSON.stringify(item.args)})`
              ),
            },
            tick()
          )
        );
      }
    }
  }
  throw new Error('single-writer simulation did not settle');
}

/**
 * `correlationId -> stepName(args)` for every step a prefix of `events` of at
 * most `maxLength` events asks for.
 */
async function stepDecisions(
  code: string,
  events: Event[],
  maxLength = events.length
) {
  const decisions = new Map<string, string>();
  for (let length = 0; length <= maxLength; length++) {
    const suspension = await replay(code, events.slice(0, length));
    for (const item of suspension?.items ?? []) {
      if (item.type === 'step') {
        decisions.set(
          item.correlationId,
          `${item.stepName}(${JSON.stringify(item.args)})`
        );
      }
    }
  }
  return decisions;
}

/**
 * For every log position after the hook's creation, whether the replay of the
 * prefix up to it reported the hook observed, and whether inserting a payload
 * there changes the step decisions of the run: one the baseline makes
 * differently, or one it never makes. Extended prefixes are compared up to the
 * baseline's length, so a payload only counts as changing the run when it is
 * acted on before the events the baseline already holds have all been
 * replayed, not when it is simply delivered to the await that comes after
 * them. A payload far ahead of every other event's time also catches a leak
 * through `Date.now()`.
 */
async function sweepHookInsertion(code: string, payloads: unknown[]) {
  const { events, hookId } = await singleWriterLog(code, payloads);
  const baseline = await stepDecisions(code, events);
  const payload = await dehydrate('out-of-band');
  const start =
    events.findIndex(
      (e) => e.eventType === 'hook_created' && e.correlationId === hookId
    ) + 1;
  const positions: { observed: boolean; changed: boolean }[] = [];
  for (let position = start; position <= events.length; position++) {
    const suspension = await replay(code, events.slice(0, position));
    const observed = suspension?.observedHookIds?.has(hookId) ?? false;
    const extended = [
      ...events.slice(0, position),
      event('hook_received', hookId, { payload }, T0 + 10_000_000),
      ...events.slice(position),
    ];
    let changed: boolean;
    try {
      const decisions = await stepDecisions(code, extended, events.length);
      changed =
        [...baseline].some(
          ([id, decision]) => decisions.get(id) !== decision
        ) || [...decisions.keys()].some((id) => !baseline.has(id));
    } catch {
      changed = true;
    }
    positions.push({ observed, changed });
  }
  return positions;
}

describe('WorkflowSuspension.observedHookIds', () => {
  it('reports a hook only once workflow code awaits it', async () => {
    const code = `async function workflow() {
      const hook = createHook({ token: "t" });
      for (let i = 0; i < 3; i++) await a(i, Date.now());
      await b(await hook, Date.now());
    }`;
    const positions = await sweepHookInsertion(code, []);
    expect(positions.map((p) => p.observed)).toEqual([
      ...Array(positions.length - 1).fill(false),
      true,
    ]);
    expect(positions.every((p) => !p.changed)).toBe(true);
  });

  it('reports a for-await hook between iterations, not during the body', async () => {
    const code = `async function workflow() {
      const hook = createHook({ token: "t" });
      for await (const message of hook) {
        await a(message, Date.now());
        await b(message, Date.now());
      }
    }`;
    const positions = await sweepHookInsertion(code, ['first']);
    expect(positions.some((p) => !p.observed)).toBe(true);
    // The loop head waits on the hook; a payload there decides the next
    // iteration, which is what the detection must flag.
    expect(positions.some((p) => p.observed && p.changed)).toBe(true);
    for (const { observed, changed } of positions) {
      if (!observed) expect(changed).toBe(false);
    }
  });

  it('reports a hook a background branch awaits for the whole branch', async () => {
    const code = `async function workflow() {
      const hook = createHook({ token: "t" });
      const background = hook.then((payload) => b(payload));
      for (let i = 0; i < 3; i++) await a(i, Date.now());
      await background;
    }`;
    const positions = await sweepHookInsertion(code, []);
    expect(positions.every((p) => p.observed)).toBe(true);
    expect(positions.some((p) => p.changed)).toBe(true);
  });

  it('keeps an unawaited hook inert across a sleep that wins a race', async () => {
    // The `wait_completed` here is delivered behind any unarmed barrier a
    // buffered payload registered below it, the interleaving run-ahead relies
    // on being inert.
    const code = `async function workflow() {
      const hook = createHook({ token: "t" });
      const winner = await Promise.race([
        sleep("1h").then(() => "wait"),
        a(0, Date.now()),
      ]);
      await b(winner, Date.now());
      await a(1, Date.now());
      await b(await hook, Date.now());
    }`;
    // The shape only exercises the wait delivery if the sleep wins.
    const { events } = await singleWriterLog(code, []);
    const decisions = [...(await stepDecisions(code, events)).values()];
    expect(decisions.some((d) => d.startsWith('b(["wait"'))).toBe(true);
    const positions = await sweepHookInsertion(code, []);
    expect(positions.map((p) => p.observed)).toEqual([
      ...Array(positions.length - 1).fill(false),
      true,
    ]);
    expect(positions.every((p) => !p.changed)).toBe(true);
  });

  it('reports a hook raced against a step while the race is pending', async () => {
    const code = `async function workflow() {
      const hook = createHook({ token: "t" });
      const winner = await Promise.race([hook.then(() => "hook"), a(0)]);
      if (winner === "hook") await b(0);
    }`;
    const positions = await sweepHookInsertion(code, []);
    for (const { observed, changed } of positions) {
      if (!observed) expect(changed).toBe(false);
    }
    expect(positions.some((p) => p.observed && p.changed)).toBe(true);
  });
});
