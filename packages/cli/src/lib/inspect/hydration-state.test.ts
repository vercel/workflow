import { afterEach, describe, expect, it } from 'vitest';
// The SDK's own writers, so the fixtures are exactly what a run stores.
import { StateContext } from '../../../../core/src/serialization/state-refs.js';
import * as workflow from '../../../../core/src/serialization/workflow.js';
import { hydrateResourceIO, resolveStateFrom } from './hydration.js';

type Message = { role: string; content: string };

/** A run whose steps each append a message; the last step's input is a reference. */
function storedRun(steps: number) {
  const writer = new StateContext();
  let history: readonly Message[] = Object.freeze([]);
  const events: unknown[] = [];
  for (let i = 0; i < steps; i++) {
    // Frozen, reusing the unchanged messages.
    const next = Object.freeze([
      ...history,
      Object.freeze({
        role: i % 2 ? 'assistant' : 'user',
        content: `message ${i}`,
      }),
    ]);
    const result = workflow.serialize(
      { history: next },
      { stateContext: writer }
    );
    history = (
      workflow.deserialize(result, { stateContext: writer }) as {
        history: Message[];
      }
    ).history;
    events.push({
      eventId: `e${i}`,
      eventType: 'step_completed',
      eventData: { result },
    });
  }
  const input = workflow.serialize({ history }, { stateContext: writer });
  let lists = 0;
  const world = {
    runs: { get: async () => ({ input: undefined }) },
    events: {
      list: async () => {
        lists++;
        return { data: events, hasMore: false };
      },
    },
  };
  return { world, input, lists: () => lists };
}

describe('CLI inspection of state stored by reference', () => {
  afterEach(() => resolveStateFrom(undefined));

  it('shows the actual value, reading the run history once', async () => {
    const run = storedRun(5);
    resolveStateFrom(run.world as never);
    const step = { runId: 'wrun_cli', stepId: 's', input: run.input };
    const shown = (await hydrateResourceIO(step)) as any;
    expect(shown.input.history).toHaveLength(5);
    expect(shown.input.history[4]).toEqual({
      role: 'user',
      content: 'message 4',
    });
    await hydrateResourceIO(step);
    expect(run.lists()).toBe(1);
  });

  it("rebuilds the value when the run's own record can't be read", async () => {
    // The vitest workbench stores runs under a tag `runs.get` doesn't find.
    const run = storedRun(3);
    run.world.runs.get = async () => {
      throw new Error('Workflow run "wrun_cli_tagged" not found');
    };
    resolveStateFrom(run.world as never);
    const step = { runId: 'wrun_cli_tagged', stepId: 's', input: run.input };
    const shown = (await hydrateResourceIO(step)) as any;
    expect(shown.input.history).toHaveLength(3);
  });

  it('rebuilds a long run in bounded time', async () => {
    const run = storedRun(2_000);
    resolveStateFrom(run.world as never);
    const step = { runId: 'wrun_cli_long', stepId: 's', input: run.input };
    // CPU time, not wall-clock time: on a busy CI runner the test process
    // spends most of its wall-clock time waiting for a core (CI measured over
    // 5 s against a 5 s budget), which says nothing about the work done here.
    const started = cpuTime();
    const shown = (await hydrateResourceIO(step)) as any;
    const first = cpuTime() - started;
    await hydrateResourceIO(step);
    expect(shown.input.history).toHaveLength(2_000);
    // The history is read once, and the second resource reuses what it rebuilt.
    expect(run.lists()).toBe(1);
    // ~0.5 s of CPU on a laptop, and about the same with every core busy:
    // the history is rebuilt once, not once per step.
    expect(first).toBeLessThan(5_000);
  });
});

/** CPU milliseconds spent by this thread (or process, on older Node). */
function cpuTime(): number {
  const usage =
    (
      process as { threadCpuUsage?: () => NodeJS.CpuUsage }
    ).threadCpuUsage?.() ?? process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}
