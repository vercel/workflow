import { afterEach, describe, expect, it } from 'vitest';
// The SDK's own writers, so the fixtures are exactly what a run stores.
import { StateContext } from '../../../../core/src/serialization/state-refs';
import * as workflow from '../../../../core/src/serialization/workflow';
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

  it('rebuilds a long run in bounded time', async () => {
    const run = storedRun(2_000);
    resolveStateFrom(run.world as never);
    const step = { runId: 'wrun_cli_long', stepId: 's', input: run.input };
    const started = performance.now();
    const shown = (await hydrateResourceIO(step)) as any;
    const first = performance.now() - started;
    const again = performance.now();
    await hydrateResourceIO(step);
    const cached = performance.now() - again;
    expect(shown.input.history).toHaveLength(2_000);
    // ~135 ms on a laptop: the history is read and rebuilt once.
    expect(first).toBeLessThan(5_000);
    expect(cached).toBeLessThan(first);
  });
});
