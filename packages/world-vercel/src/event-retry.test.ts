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
  isRetryableEventPostError,
  MAX_EVENT_POST_RETRIES,
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
});
