import { afterEach, describe, expect, it, vi } from 'vitest';

// Under Bun, `import { Agent } from 'undici'` resolves to Bun's built-in
// module, whose dispatcher classes have no `compose` or `dispatch` (#4555).
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class BunAgent {
    constructor(readonly options?: unknown) {}
    close(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): Promise<void> {
      return Promise.resolve();
    }
  }
  class BunRetryAgent extends BunAgent {
    constructor(
      readonly dispatcher: unknown,
      options?: unknown
    ) {
      super(options);
    }
  }
  return { ...actual, Agent: BunAgent, RetryAgent: BunRetryAgent };
});

const { Agent, RetryAgent } = await import('undici');
const { createEventsDispatcher, createQueueDispatcher, supportsCompose } =
  await import('./http-client.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dispatchers under Bun’s built-in undici', () => {
  it('detects that the runtime cannot compose interceptors', () => {
    expect(supportsCompose(new Agent())).toBe(false);
  });

  it('builds the queue dispatcher around the plain agent', () => {
    const dispatcher = createQueueDispatcher() as unknown as {
      dispatcher: unknown;
    };
    expect(dispatcher.dispatcher).toBeInstanceOf(Agent);
  });

  it.each([
    ['enabled', '1'],
    ['disabled', '0'],
  ])('builds the events dispatcher as a bare RetryAgent with HTTP/2 multiplexing %s', (_label, flag) => {
    vi.stubEnv('WORKFLOW_H2_MULTIPLEX', flag);
    const dispatcher = createEventsDispatcher() as unknown as {
      dispatcher: unknown;
    };
    expect(dispatcher).toBeInstanceOf(RetryAgent);
    expect(dispatcher.dispatcher).toBeInstanceOf(Agent);
  });
});
