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
});
