import { describe, expect, it } from 'vitest';
import {
  deserializeQueueMessage,
  serializeQueueMessage,
} from './queue-json.js';

describe('queue JSON codec', () => {
  it('round-trips Uint8Array values and views', () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const message = {
      runId: 'wrun_1',
      runInput: { input: backing.subarray(1, 4) },
    };

    const decoded = deserializeQueueMessage(
      serializeQueueMessage(message)
    ) as typeof message;

    expect(decoded.runId).toBe('wrun_1');
    expect(decoded.runInput.input).toBeInstanceOf(Uint8Array);
    expect([...decoded.runInput.input]).toEqual([1, 2, 3]);
  });

  it('does not revive lookalike values with an invalid data field', () => {
    const message = {
      __type: 'Uint8Array',
      data: 123,
    };

    expect(deserializeQueueMessage(serializeQueueMessage(message))).toEqual(
      message
    );
  });
});
