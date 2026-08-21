import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { EventTypeSchema } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_RETRY_ELIGIBILITY,
  EventPostResponseError,
  isRetryableEventPostError,
  MAX_EVENT_POST_RETRIES,
  THROTTLE_RETRY_BUDGET_MS,
  withEventPostRetry,
} from './event-retry.js';

const transportErr = (code: string) =>
  Object.assign(new Error(`transport ${code}`), { code });

// undici `fetch` wraps low-level failures in a TypeError whose `cause` carries
// the real code — the classifier must walk the cause chain.
const fetchFailed = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('underlying'), { code }),
  });

describe('EVENT_RETRY_ELIGIBILITY', () => {
  it('classifies every world event type (no gaps)', () => {
    for (const type of EventTypeSchema.options) {
      const policy = EVENT_RETRY_ELIGIBILITY[type];
      expect(policy, `missing policy for ${type}`).toBeDefined();
      expect(typeof policy.retryable).toBe('boolean');
      expect(policy.reason.length).toBeGreaterThan(0);
    }
  });

  it('marks idempotent-on-retry events retryable', () => {
    for (const type of [
      'run_created',
      'run_started',
      'run_completed',
      'run_failed',
      'run_cancelled',
      'attr_set',
      'step_created',
      'step_completed',
      'step_failed',
      'wait_created',
      'wait_completed',
      'hook_created',
      'hook_disposed',
    ] as const) {
      expect(EVENT_RETRY_ELIGIBILITY[type].retryable, type).toBe(true);
    }
  });

  it('excludes events that are unsafe to blindly retry', () => {
    // step_started double-increments attempt; step_retrying / hook_received
    // append a duplicate event row; hook_conflict is server-originated.
    for (const type of [
      'step_started',
      'step_retrying',
      'hook_received',
      'hook_conflict',
    ] as const) {
      expect(EVENT_RETRY_ELIGIBILITY[type].retryable, type).toBe(false);
    }
  });
});

describe('isRetryableEventPostError', () => {
  it('retries transient 5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(
        isRetryableEventPostError(new WorkflowWorldError('boom', { status }))
      ).toBe(true);
    }
  });

  it('does not retry 4xx definitive responses', () => {
    for (const status of [400, 404]) {
      expect(
        isRetryableEventPostError(new WorkflowWorldError('nope', { status }))
      ).toBe(false);
    }
  });

  it('does not retry server-considered conflicts/terminal/too-early/throttle', () => {
    expect(isRetryableEventPostError(new EntityConflictError('409'))).toBe(
      false
    );
    expect(isRetryableEventPostError(new RunExpiredError('410'))).toBe(false);
    expect(isRetryableEventPostError(new TooEarlyError('425'))).toBe(false);
    expect(isRetryableEventPostError(new ThrottleError('429'))).toBe(false);
  });

  it('retries a body-parse failure (write may have landed)', () => {
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('parse', { code: 'PARSE_ERROR' })
      )
    ).toBe(true);
  });

  it('does not repeat a POST to repair a failed response continuation', () => {
    const transport = new WorkflowWorldError('continuation failed', {
      code: 'TRANSPORT',
    });
    expect(
      isRetryableEventPostError(
        new EventPostResponseError('POST response already accepted', {
          cause: transport,
        })
      )
    ).toBe(false);
  });

  it('retries a TRANSPORT failure from either transport', () => {
    // The one code that lets this policy serve HTTP and WS alike: `utils.ts`
    // sets it for a `fetch` that failed transiently, `events-v4.ts` for a WS
    // socket that died or produced no correlatable reply. Both mean the write
    // was never acked.
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('POST … transport failure: socket hang up', {
          code: 'TRANSPORT',
        })
      )
    ).toBe(true);
  });

  it('retries a TRANSPORT failure whose cause carries no known marker', () => {
    // Why the code has to be read directly rather than left to the cause walk:
    // a WS failure's cause is a `WsTransportError`, which carries none of the
    // undici/Node markers in TRANSIENT_CODES.
    const cause = Object.assign(new Error('connection closed (code 1006)'), {
      name: 'WsTransportError',
    });
    expect(isRetryableEventPostError(cause)).toBe(false);
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('POST … transport failure: connection closed', {
          code: 'TRANSPORT',
          cause,
        })
      )
    ).toBe(true);
  });

  it('does not retry a TIMEOUT that is a caller-requested abort', () => {
    // `utils.ts` maps both a missed deadline and an `AbortError` onto
    // `code: 'TIMEOUT'`, so — unlike TRANSPORT — that code must not be a
    // blanket yes; it falls through to the marker walk, which tells them apart.
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('request aborted', {
          code: 'TIMEOUT',
          cause: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        })
      )
    ).toBe(false);
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('request timed out', {
          code: 'TIMEOUT',
          cause: Object.assign(new Error('timed out'), {
            name: 'TimeoutError',
          }),
        })
      )
    ).toBe(true);
  });

  it('retries raw transport errors by code', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_REQ_RETRY',
      'UND_ERR_HEADERS_TIMEOUT',
    ]) {
      expect(isRetryableEventPostError(transportErr(code)), code).toBe(true);
    }
  });

  it('retries transport errors hidden under a `fetch failed` cause', () => {
    expect(isRetryableEventPostError(fetchFailed('UND_ERR_SOCKET'))).toBe(true);
  });

  it('retries our own timeout (TimeoutError) but not an external abort (AbortError)', () => {
    // Self-deadline via AbortSignal.timeout → TimeoutError → ambiguous, retry.
    expect(
      isRetryableEventPostError(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      )
    ).toBe(true);
    // Caller-requested cancellation surfaces as AbortError → must NOT be retried.
    expect(
      isRetryableEventPostError(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      )
    ).toBe(false);
    // Also when wrapped by makeRequest as a WorkflowWorldError(cause).
    expect(
      isRetryableEventPostError(
        new WorkflowWorldError('request aborted', {
          cause: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        })
      )
    ).toBe(false);
  });

  it('does not retry an unclassified error', () => {
    expect(isRetryableEventPostError(new Error('something else'))).toBe(false);
  });
});

describe('withEventPostRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a retryable event past a transient blip and returns the result', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw transportErr('ECONNRESET');
      return 'ok';
    });

    const p = withEventPostRetry(fn, 'step_completed');
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 409 that appears on a retry (original landed)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw transportErr('ECONNRESET');
      // The first attempt actually landed; the retry observes the conflict.
      throw new EntityConflictError('already completed');
    });

    const p = withEventPostRetry(fn, 'step_completed').catch((e) => e);
    await vi.runAllTimersAsync();

    const err = await p;
    expect(EntityConflictError.is(err)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_EVENT_POST_RETRIES and throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw transportErr('ECONNRESET');
    });

    const p = withEventPostRetry(fn, 'step_completed').catch((e) => e);
    await vi.runAllTimersAsync();

    const err = await p;
    expect((err as { code?: string }).code).toBe('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(MAX_EVENT_POST_RETRIES + 1);
  });

  it('does not retry a definitive failure even for a retryable event', async () => {
    const fn = vi.fn(async () => {
      throw new WorkflowWorldError('bad request', { status: 400 });
    });

    await expect(withEventPostRetry(fn, 'step_completed')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an excluded event (step_started — protects the attempt counter)', async () => {
    const fn = vi.fn(async () => {
      throw transportErr('ECONNRESET');
    });

    await expect(withEventPostRetry(fn, 'step_started')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an excluded event (hook_received — avoids double-delivery)', async () => {
    const fn = vi.fn(async () => {
      throw transportErr('ECONNRESET');
    });

    await expect(withEventPostRetry(fn, 'hook_received')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe('throttle (429) in-process retry', () => {
    it('retries a ThrottleError after its retryAfter and returns the result', async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new ThrottleError('429', { retryAfter: 14 });
        return 'ok';
      });

      const p = withEventPostRetry(fn, 'step_completed');
      // Not yet retried before the server's requested wait has elapsed.
      await vi.advanceTimersByTimeAsync(13_000);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('applies to eligibility-excluded events too (429 is a definitive no-write)', async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new ThrottleError('429', { retryAfter: 1 });
        return 'ok';
      });

      const p = withEventPostRetry(fn, 'step_started');
      await vi.runAllTimersAsync();

      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('defaults to a 1s wait when the 429 carries no retryAfter', async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new ThrottleError('429');
        return 'ok';
      });

      const p = withEventPostRetry(fn, 'run_started');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('surfaces the ThrottleError once the cumulative wait budget is exhausted', async () => {
      const fn = vi.fn(async () => {
        throw new ThrottleError('429', { retryAfter: 14 });
      });

      const p = withEventPostRetry(fn, 'step_completed').catch((e) => e);
      await vi.runAllTimersAsync();

      const err = await p;
      expect(ThrottleError.is(err)).toBe(true);
      // 14s per attempt against a 30s budget: 14 + 14 fits, a third doesn't.
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('surfaces immediately when retryAfter alone exceeds the budget', async () => {
      const fn = vi.fn(async () => {
        throw new ThrottleError('429', {
          retryAfter: THROTTLE_RETRY_BUDGET_MS / 1000 + 1,
        });
      });

      await expect(withEventPostRetry(fn, 'step_completed')).rejects.toThrow(
        '429'
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not consume the transient retry allowance', async () => {
      // A throttle wait followed by transient blips: the transient counter
      // still permits MAX_EVENT_POST_RETRIES retries.
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new ThrottleError('429', { retryAfter: 1 });
        if (calls <= 1 + MAX_EVENT_POST_RETRIES)
          throw transportErr('ECONNRESET');
        return 'ok';
      });

      const p = withEventPostRetry(fn, 'step_completed');
      await vi.runAllTimersAsync();

      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2 + MAX_EVENT_POST_RETRIES);
    });
  });

  describe('idempotentHookResume opt-in', () => {
    it('retries an atomic hook resume (resumeId + digest) past an ECONNRESET', async () => {
      // The (runId, resumeId) claim makes the write idempotent-on-retry: a
      // retry whose original landed converges on the same canonical event.
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) throw transportErr('ECONNRESET');
        return 'ok';
      });

      const p = withEventPostRetry(fn, 'hook_received', {
        idempotentHookResume: true,
      });
      await vi.runAllTimersAsync();

      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('keeps plain hook_received single-attempt when the opt-in is absent', async () => {
      const fn = vi.fn(async () => {
        throw transportErr('ECONNRESET');
      });

      await expect(
        withEventPostRetry(fn, 'hook_received', {})
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('keeps an incomplete idempotency shape single-attempt (opt-in false)', async () => {
      // The caller computes the opt-in from resumeId AND digest presence —
      // resumeId-only / digest-only writes arrive here with false.
      const fn = vi.fn(async () => {
        throw transportErr('ECONNRESET');
      });

      await expect(
        withEventPostRetry(fn, 'hook_received', {
          idempotentHookResume: false,
        })
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('never retries a definitive response, even with the opt-in', async () => {
      const fn = vi.fn(async () => {
        throw new WorkflowWorldError('digest reuse', { status: 422 });
      });

      await expect(
        withEventPostRetry(fn, 'hook_received', {
          idempotentHookResume: true,
        })
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not widen retries for other event types', async () => {
      const fn = vi.fn(async () => {
        throw transportErr('ECONNRESET');
      });

      await expect(
        withEventPostRetry(fn, 'step_started', {
          idempotentHookResume: true,
        })
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
