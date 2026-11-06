import { FatalError } from '@workflow/errors';
import { produce } from 'immer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recoverStateContext,
  WorkflowStateRecoveryError,
} from './state-recovery.js';
import { StateContext } from './state-refs.js';
import * as workflow from './workflow.js';

const world = {
  runs: { get: vi.fn() },
  events: { list: vi.fn() },
};
vi.mock('../runtime/get-world-lazy.js', () => ({
  getWorldLazy: async () => world,
}));

type Message = { role: string; content: string };

/** A step output holding produced state, and a later input referring to it. */
function stored() {
  const replay = new StateContext();
  const output = workflow.serialize(
    {
      history: produce(
        [] as Message[],
        (d) => void d.push({ role: 'user', content: 'hi' })
      ),
    },
    { stateContext: replay }
  );
  const given = workflow.deserialize(output, { stateContext: replay }) as {
    history: Message[];
  };
  const input = workflow.serialize(given, {
    stateContext: replay,
    stateInput: true,
  });
  return { output, input };
}

describe('recoverStateContext', () => {
  beforeEach(() => {
    world.runs.get.mockReset();
    world.events.list.mockReset();
  });

  it('rebuilds referenced state and records what it read', async () => {
    const { output, input } = stored();
    world.runs.get.mockResolvedValue({ input: undefined });
    world.events.list.mockResolvedValue({
      data: [
        {
          eventId: 'e1',
          eventType: 'step_completed',
          eventData: { result: output },
        },
      ],
      hasMore: false,
    });
    const context = await recoverStateContext('wrun_1', undefined, input);
    expect(context?.stats.recoveryFetches).toBe(1);
    expect(context?.stats.recoveryBytes).toBeGreaterThan(0);
    expect(
      workflow.deserialize(input, { stateContext: context, stateInput: true })
    ).toEqual({ history: [{ role: 'user', content: 'hi' }] });
  });

  it('reports a World read failure as retryable infrastructure, not a step failure', async () => {
    const { input } = stored();
    world.runs.get.mockResolvedValue({ input: undefined });
    world.events.list.mockRejectedValue(new Error('socket hang up'));
    const error = await recoverStateContext('wrun_1', undefined, input).catch(
      (e) => e
    );
    expect(WorkflowStateRecoveryError.is(error)).toBe(true);
    expect(FatalError.is(error)).toBe(false);
  });

  it('fails a log too large to recover fatally, so retries are not spent on it', async () => {
    const { input } = stored();
    world.runs.get.mockResolvedValue({ input: undefined });
    let page = 0;
    world.events.list.mockImplementation(async () => ({
      data: [],
      hasMore: true,
      cursor: `c${page++}`,
    }));
    const error = await recoverStateContext('wrun_1', undefined, input).catch(
      (e) => e
    );
    expect(FatalError.is(error)).toBe(true);
  });

  // Known issues from the review on #5215. Each test states the intended
  // behavior and is expected to fail until its fix lands: drop `.fails` then.
  describe('known issues', () => {
    it.fails('counts only payloads holding state toward the recovery budget', async () => {
      const { output, input } = stored();
      const unrelated = workflow.serialize(
        { file: 'x'.repeat(1024 * 1024) },
        { stateContext: new StateContext() }
      );
      world.runs.get.mockResolvedValue({ input: undefined });
      world.events.list.mockResolvedValue({
        data: [
          {
            eventId: 'e1',
            eventType: 'step_completed',
            eventData: { result: output },
          },
          {
            eventId: 'e2',
            eventType: 'step_completed',
            eventData: { result: unrelated },
          },
        ],
        hasMore: false,
      });
      const context = await recoverStateContext('wrun_1', undefined, input);
      // A run with large unrelated outputs must not reach the fatal 256 MiB limit.
      expect(context?.stats.recoveryBytes).toBeLessThan(unrelated.byteLength);
    });

    it.fails('registers only the hook payloads replay delivers', async () => {
      // The same long text arrives twice: first in a payload replay never
      // delivers (for example after its hook was disposed), then in one it does.
      const text =
        'The same long message, resubmitted after the first hook went away. '.repeat(
          3
        );
      const replay = new StateContext();
      const v1 = workflow.deserialize(
        workflow.serialize(
          {
            chat: produce(
              { log: [] as string[] },
              (d) => void d.log.push('start')
            ),
          },
          { stateContext: new StateContext() }
        ),
        { stateContext: replay }
      ) as { chat: { log: string[] } };
      const first = workflow.serialize(
        { text },
        { stateContext: new StateContext() }
      );
      const second = workflow.serialize(
        { text },
        { stateContext: new StateContext() }
      );
      replay.addSource('hook:e3', { text }); // replay delivers only the second
      const out1 = workflow.serialize(v1, { stateContext: new StateContext() });
      world.runs.get.mockResolvedValue({ input: undefined });
      world.events.list.mockResolvedValue({
        data: [
          {
            eventId: 'e1',
            eventType: 'step_completed',
            eventData: { result: out1 },
          },
          {
            eventId: 'e2',
            eventType: 'hook_received',
            eventData: { payload: first },
          },
          {
            eventId: 'e3',
            eventType: 'hook_received',
            eventData: { payload: second },
          },
        ],
        hasMore: false,
      });
      // A cold step writes its output against the recovered context.
      const recovered = await recoverStateContext(
        'wrun_1',
        undefined,
        workflow.serialize(v1, { stateContext: replay, stateInput: true })
      );
      const given = workflow.deserialize(
        workflow.serialize(v1, { stateContext: replay, stateInput: true }),
        { stateContext: recovered, stateInput: true }
      ) as { chat: { log: string[] } };
      const output = workflow.serialize(
        { chat: produce(given.chat, (d) => void d.log.push(text)) },
        { stateContext: recovered }
      );
      // The next replay must read it.
      const next = new StateContext();
      workflow.deserialize(out1, { stateContext: next });
      next.addSource('hook:e3', { text });
      expect(
        (workflow.deserialize(output, { stateContext: next }) as any).chat.log
      ).toEqual(['start', text]);
    });
  });
});
