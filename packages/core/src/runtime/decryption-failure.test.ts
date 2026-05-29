import { RuntimeDecryptionError } from '@workflow/errors';
import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { DECRYPTION_FAILURE_MAX_RETRIES } from './constants.js';
import { shouldRedriveOnDecryptionFailure } from './decryption-failure.js';

function makeMockWorld(
  processExitTriggersQueueRedelivery: boolean | undefined
): World {
  return { processExitTriggersQueueRedelivery } as unknown as World;
}

function makeError(): RuntimeDecryptionError {
  return new RuntimeDecryptionError(
    'AES-256-GCM decryption failed: The operation failed for an operation-specific reason',
    {
      cause: Object.assign(new Error('boom'), { name: 'OperationError' }),
      context: { operation: 'decrypt', byteLength: 1234, formatPrefix: 'encr' },
    }
  );
}

describe('shouldRedriveOnDecryptionFailure', () => {
  beforeEach(() => {
    // Silence the run-scoped logger; tests don't introspect its calls.
    const noopLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      forRun: vi.fn(),
      child: vi.fn(),
    };
    noopLogger.forRun.mockReturnValue(noopLogger);
    noopLogger.child.mockReturnValue(noopLogger);
    vi.spyOn(runtimeLogger, 'forRun').mockReturnValue(noopLogger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for in-process Worlds (no exit-for-redelivery support)', () => {
    expect(
      shouldRedriveOnDecryptionFailure({
        world: makeMockWorld(false),
        error: makeError(),
        runId: 'wrun_test',
        workflowName: 'wf',
        attempt: 1,
      })
    ).toBe(false);
  });

  it('returns false when the World omits the capability (default = undefined)', () => {
    expect(
      shouldRedriveOnDecryptionFailure({
        world: makeMockWorld(undefined),
        error: makeError(),
        runId: 'wrun_test',
        workflowName: 'wf',
        attempt: 1,
      })
    ).toBe(false);
  });

  it('returns true on early attempts when the World supports exit-for-redelivery', () => {
    for (
      let attempt = 1;
      attempt <= DECRYPTION_FAILURE_MAX_RETRIES;
      attempt++
    ) {
      expect(
        shouldRedriveOnDecryptionFailure({
          world: makeMockWorld(true),
          error: makeError(),
          runId: 'wrun_test',
          workflowName: 'wf',
          attempt,
        })
      ).toBe(true);
    }
  });

  it('returns false once the retry budget is exceeded (managed World)', () => {
    expect(
      shouldRedriveOnDecryptionFailure({
        world: makeMockWorld(true),
        error: makeError(),
        runId: 'wrun_test',
        workflowName: 'wf',
        attempt: DECRYPTION_FAILURE_MAX_RETRIES + 1,
      })
    ).toBe(false);
  });
});
