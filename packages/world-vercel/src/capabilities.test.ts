import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from './index.js';

vi.mock('@vercel/queue', () => ({
  QueueClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(), handleCallback: vi.fn() })),
  DuplicateMessageError: class extends Error {},
  MessageNotFoundError: class extends Error {},
  createQueueCallbackHandler: vi.fn(),
}));

describe('createWorld() capabilities', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    } else {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = original;
    }
  });

  it('declares serializedRunContinuations by default', () => {
    delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;

    // Per-run flow topics are on by default, so a run's wake-ups queue behind
    // any in-flight invocation of that run. The core runtime must see this to
    // avoid blocking an invocation on an inline step body.
    expect(createWorld().capabilities?.serializedRunContinuations).toBe(true);
  });

  it('drops serializedRunContinuations when sequential replays are disabled', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '0';

    expect(createWorld().capabilities?.serializedRunContinuations).toBe(false);
  });
});
