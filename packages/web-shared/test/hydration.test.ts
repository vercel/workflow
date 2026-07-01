import { importKey } from '@workflow/core/encryption';
import {
  dehydrateStepError,
  dehydrateStepReturnValue,
} from '@workflow/core/serialization';
import { hydrateData } from '@workflow/core/serialization-format';
import { FatalError, RetryableError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  getWebRevivers,
  hasEncryptedFields,
  hydrateResourceIO,
  hydrateResourceIOAsync,
  hydrateResourceIOWithKey,
  isEncryptedMarker,
} from '../src/lib/hydration.js';

/**
 * The web reviver set must mirror every key in `SerializableSpecial` (see
 * `packages/core/src/serialization/types.ts`). When the runtime reducer set
 * adds a new tagged type — historically `FatalError`, `RetryableError`,
 * the built-in `Error` subclasses, `DOMException`, etc. — the web set must
 * grow in lockstep. Otherwise `devalue.unflatten` throws `"Unknown type X"`,
 * which `hydrateResourceIO` swallows and surfaces as a "Failed to load
 * resource details" banner in the o11y UI.
 *
 * These tests round-trip real values through the runtime's
 * `dehydrateStepError` (the production code path that produces the wire
 * bytes for `step_failed.error` etc.) and then through the web reviver
 * set, so they catch divergence on either side.
 */

const REVIVERS = getWebRevivers();
const textDecoder = new TextDecoder();

/** Run a real value through the production wire path with no encryption. */
async function roundTrip<T>(value: unknown): Promise<T> {
  const wire = await dehydrateStepError(value, 'run_test', undefined);
  return hydrateData(wire, REVIVERS) as T;
}

describe('getWebRevivers — error family', () => {
  it('hydrates a base Error', async () => {
    const original = new Error('boom', { cause: 'because' });
    const revived = await roundTrip<Error & { cause?: unknown }>(original);
    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('Error');
    expect(revived.message).toBe('boom');
    expect(revived.cause).toBe('because');
  });

  // biome-ignore format: visual alignment
  const subclasses = [
    ['EvalError',      EvalError],
    ['RangeError',     RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError',    SyntaxError],
    ['TypeError',      TypeError],
    ['URIError',       URIError],
  ] as const;

  it.each(subclasses)('hydrates %s as a real instance', async (name, Ctor) => {
    const revived = await roundTrip<Error>(new Ctor('boom'));
    expect(revived).toBeInstanceOf(Ctor);
    expect(revived.name).toBe(name);
    expect(revived.message).toBe('boom');
  });

  it('hydrates an AggregateError with its `errors` array intact', async () => {
    const original = new AggregateError(
      [new Error('a'), new Error('b')],
      'all failed'
    );
    const revived = await roundTrip<AggregateError>(original);
    expect(revived).toBeInstanceOf(AggregateError);
    expect(revived.message).toBe('all failed');
    expect(revived.errors).toHaveLength(2);
    expect((revived.errors[0] as Error).message).toBe('a');
    expect((revived.errors[1] as Error).message).toBe('b');
  });

  it('hydrates a DOMException with name preserved', async () => {
    // `DOMException` is the value seen by web o11y when
    // `AbortController.abort()` is called with no argument and that
    // signal.reason crosses a step boundary — the same code path that
    // surfaced "Unknown type FatalError" before the symmetric web revivers
    // landed.
    const revived = await roundTrip<Error>(
      new DOMException('aborted', 'AbortError')
    );
    expect(revived.message).toBe('aborted');
    expect(revived.name).toBe('AbortError');
  });

  it('hydrates a FatalError with name="FatalError"', async () => {
    // Regression test for the screenshot bug: "Unknown type FatalError"
    // surfaced from devalue.unflatten when the symmetric web reviver was
    // missing. Round-trips a real `FatalError` through the runtime wire
    // path so any divergence between the reducer and reviver is caught.
    const revived = await roundTrip<Error>(new FatalError('cannot retry'));
    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('FatalError');
    expect(revived.message).toBe('cannot retry');
  });

  it('hydrates a HookConflictError with token details preserved', () => {
    const revived = hydrateData(
      [
        ['HookConflictError', 1],
        { message: 2, stack: 3, token: 4, conflictingRunId: 5 },
        'Hook token "approval-token" is already in use by another workflow (run "wrun_conflicting")',
        'HookConflictError: Hook token "approval-token" is already in use by another workflow',
        'approval-token',
        'wrun_conflicting',
      ],
      REVIVERS
    ) as Error & { token?: string; conflictingRunId?: string };

    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('HookConflictError');
    expect(revived.message).toContain('already in use');
    expect(revived.token).toBe('approval-token');
    expect(revived.conflictingRunId).toBe('wrun_conflicting');
  });

  it('hydrates a RetryableError with retryAfter as a Date', async () => {
    const retryAt = new Date('2025-01-01T00:00:00.000Z');
    const revived = await roundTrip<Error & { retryAfter: Date }>(
      new RetryableError('try again', { retryAfter: retryAt })
    );
    expect(revived.name).toBe('RetryableError');
    expect(revived.message).toBe('try again');
    // `retryAfter` is wire-encoded as an epoch ms number for realm-safety
    // (see the runtime RetryableError reducer); the web reviver must
    // rehydrate it back into a Date.
    expect(revived.retryAfter).toBeInstanceOf(Date);
    expect(revived.retryAfter.toISOString()).toBe(retryAt.toISOString());
  });

  it('omits retryAfter when missing from the payload (older runtime)', () => {
    // Defensive path: a payload produced by an older runtime that predates
    // the `retryAfter` field would be missing it. The reviver must not
    // produce `new Date(undefined)` (an Invalid Date) — the field should
    // simply be absent from the resulting Error.
    const retryableReviver = (REVIVERS as Record<string, (v: any) => unknown>)
      .RetryableError;
    const revived = retryableReviver({
      message: 'try again',
      stack: 'RetryableError: try again',
    }) as Error & { retryAfter?: Date };
    expect(revived.name).toBe('RetryableError');
    expect(revived.message).toBe('try again');
    expect(revived.retryAfter).toBeUndefined();
  });
});

describe('front hydration — encrypted compressed payloads', () => {
  const runId = 'wrun_test';
  const rawKey = new Uint8Array(32).fill(7);

  function formatPrefix(value: unknown): string {
    expect(value).toBeInstanceOf(Uint8Array);
    return textDecoder.decode((value as Uint8Array).subarray(0, 4));
  }

  it('keeps encrypted compressed step errors as markers until decrypting them with the run key', async () => {
    const cryptoKey = await importKey(rawKey);
    const original = new Error(
      `boom ${'front encrypted payload '.repeat(400)}`
    );
    const wire = await dehydrateStepError(
      original,
      runId,
      cryptoKey,
      [],
      globalThis,
      true
    );

    expect(formatPrefix(wire)).toBe('encr');

    const hydrated = hydrateResourceIO({
      stepId: 'step_test',
      error: wire,
    });

    expect(isEncryptedMarker(hydrated.error)).toBe(true);
    expect(hasEncryptedFields(hydrated)).toBe(true);

    const decrypted = await hydrateResourceIOWithKey(hydrated, rawKey);
    expect(decrypted.error).toBeInstanceOf(Error);
    expect((decrypted.error as Error).message).toBe(original.message);
  });

  it('hydrates unencrypted compressed step errors through the async web path', async () => {
    const original = new Error(
      `boom ${'oss web compressed payload '.repeat(400)}`
    );
    const wire = await dehydrateStepError(
      original,
      runId,
      undefined,
      [],
      globalThis,
      true
    );

    expect(['gzip', 'zstd']).toContain(formatPrefix(wire));

    const hydrated = await hydrateResourceIOAsync({
      stepId: 'step_test',
      error: wire,
    });

    expect(hydrated.error).toBeInstanceOf(Error);
    expect((hydrated.error as Error).message).toBe(original.message);
  });

  it('decrypts encrypted compressed v4 step_started input payloads', async () => {
    const cryptoKey = await importKey(rawKey);
    const input = ['probe', { message: 'encrypted front payload' }];
    const wire = await dehydrateStepReturnValue(
      input,
      runId,
      cryptoKey,
      [],
      globalThis,
      false,
      false,
      true
    );

    expect(formatPrefix(wire)).toBe('encr');

    const hydrated = hydrateResourceIO({
      eventId: 'evnt_test',
      eventType: 'step_started',
      eventData: {
        stepName: 'probe',
        input: wire,
      },
    });

    expect(isEncryptedMarker(hydrated.eventData.input)).toBe(true);
    expect(hasEncryptedFields(hydrated)).toBe(true);

    const decrypted = await hydrateResourceIOWithKey(hydrated, rawKey);
    expect(decrypted.eventData.input).toEqual(input);
  });
});
