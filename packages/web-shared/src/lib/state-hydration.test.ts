import { produce } from 'immer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The SDK's own writers, so the fixtures are exactly what a run stores.
import { StateContext } from '../../../core/src/serialization/state-refs';
import * as workflow from '../../../core/src/serialization/workflow';
import { hydrateResourceIOAsync } from './hydration';
import { createRunStateHydrator } from './state-hydration';

type Message = { role: string; content: string };

/** A run whose second step's input refers to the first step's output. */
function storedRun() {
  const body = new StateContext();
  const write = (value: unknown) =>
    workflow.serialize(value, { stateContext: body });
  const read = (bytes: Uint8Array) =>
    workflow.deserialize(bytes, { stateContext: body }) as any;

  const output1 = write({
    history: produce([] as Message[], (d) => {
      d.push({ role: 'user', content: 'hello' });
    }),
  });
  const v1 = read(output1).history;
  const input2 = write({ history: v1 });
  const output2 = write({
    history: produce(v1 as Message[], (d) => {
      d.push({ role: 'assistant', content: 'hi' });
    }),
  });
  const runInput = workflow.serialize(
    { prompt: 'hello' },
    { stateContext: new StateContext() }
  );
  const events = [
    { eventId: 'e1', eventType: 'run_created', eventData: {} },
    {
      eventId: 'e2',
      eventType: 'step_completed',
      eventData: { result: output1 },
    },
    {
      eventId: 'e3',
      eventType: 'step_completed',
      eventData: { result: output2 },
    },
  ];
  return { runInput, input2, output2, events };
}

describe('createRunStateHydrator', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('shows the actual input and output of a step, reading the history once', async () => {
    const run = storedRun();
    const loadRunInput = vi.fn(async () => run.runInput);
    const loadEvents = vi.fn(async () => ({
      data: run.events,
      hasMore: false,
    }));
    const hydrator = createRunStateHydrator({ loadRunInput, loadEvents });
    const step = { stepId: 's2', input: run.input2, output: run.output2 };

    // Without the history the input is only a placeholder.
    const plain = (await hydrateResourceIOAsync(step)) as any;
    expect(plain.input.history).toMatch(/^<state /);

    const shown = (await hydrator.hydrate(step)) as any;
    expect(shown.input.history).toEqual([{ role: 'user', content: 'hello' }]);
    expect(shown.output.history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);

    // Later inspections reuse what was read.
    await hydrator.hydrate(step);
    expect(loadEvents).toHaveBeenCalledTimes(1);
    expect(loadRunInput).toHaveBeenCalledTimes(1);
  });

  it('stops reading when the events cursor does not advance', async () => {
    const run = storedRun();
    // A misbehaving backend: always more, always the same cursor.
    const loadEvents = vi.fn(async () => ({
      data: [],
      cursor: 'stuck',
      hasMore: true,
    }));
    const hydrator = createRunStateHydrator({
      loadRunInput: async () => run.runInput,
      loadEvents,
    });
    const shown = (await hydrator.hydrate({
      stepId: 's2',
      input: run.input2,
    })) as any;
    expect(shown.input.history).toMatch(/^<state /);
    expect(loadEvents).toHaveBeenCalledTimes(2);
  });

  it('does not read the history for values that do not need it', async () => {
    const loadEvents = vi.fn();
    const hydrator = createRunStateHydrator({
      loadRunInput: vi.fn(),
      loadEvents,
    });
    const run = storedRun();
    const shown = (await hydrator.hydrate({ input: run.runInput })) as any;
    expect(shown.input).toEqual({ prompt: 'hello' });
    expect(loadEvents).not.toHaveBeenCalled();
  });

  it('reads only newer events when a later step needs them', async () => {
    const run = storedRun();
    const pages = [
      { data: run.events.slice(0, 1), cursor: 'c1', hasMore: false },
      { data: run.events, cursor: 'c2', hasMore: false },
    ];
    const loadEvents = vi.fn(async () => pages.shift()!);
    const hydrator = createRunStateHydrator({
      loadRunInput: async () => run.runInput,
      loadEvents,
    });
    const step = { input: run.input2 };

    // The first read happened before the step that stored the state.
    expect(((await hydrator.hydrate(step)) as any).input.history).toMatch(
      /^<state /
    );
    expect(((await hydrator.hydrate(step)) as any).input.history).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(loadEvents).toHaveBeenNthCalledWith(2, 'c1');
  });

  it('resolves strings later state takes from a hook payload', async () => {
    const message = 'Weather in Oslo for the next three days, please. '.repeat(
      4
    );
    const hook = workflow.serialize(
      { message },
      { stateContext: new StateContext() }
    );
    const replay = new StateContext();
    replay.addSource(
      'hook:evnt_h',
      workflow.deserialize(hook, { stateContext: replay })
    );
    const output = workflow.serialize(
      {
        history: produce([] as Message[], (d) => {
          d.push({ role: 'user', content: message });
        }),
      },
      { stateContext: replay }
    );
    const v1 = (workflow.deserialize(output, { stateContext: replay }) as any)
      .history;
    const input = workflow.serialize({ history: v1 }, { stateContext: replay });
    const hydrator = createRunStateHydrator({
      loadRunInput: async () => undefined,
      loadEvents: async () => ({
        data: [
          {
            eventId: 'evnt_h',
            eventType: 'hook_received',
            eventData: { payload: hook },
          },
          {
            eventId: 'e2',
            eventType: 'step_completed',
            eventData: { result: output },
          },
        ],
        hasMore: false,
      }),
    });
    const shown = (await hydrator.hydrate({ input })) as any;
    expect(shown.input.history).toEqual([{ role: 'user', content: message }]);
  });
});
