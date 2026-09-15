import { describe, expect, it } from 'vitest';
import {
  EntityConflictError,
  HookConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  ThrottleError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from './index.js';
import {
  captureInvocationOutcome,
  deserializeWorkflowError,
  serializeWorkflowError,
  unwrapInvocationOutcome,
} from './invocation.js';

describe('invocation outcomes', () => {
  it.each([
    new HookNotFoundError('token'),
    new HookConflictError('token', 'other-run'),
    new WorkflowRunNotFoundError('run'),
    new EntityConflictError('conflict'),
    new RunExpiredError('expired', 'run', 'completed', new Date('2026-01-01')),
    new ThrottleError('busy', { retryAfter: 3 }),
    new PreconditionFailedError('stale', {
      details: { data: new Uint8Array([1, 2]) },
    }),
    new WorkflowWorldError('bad argument', {
      status: 422,
      code: 'INVALID_ARGUMENT',
      field: 'input',
      url: 'https://example.test',
      cause: new HookNotFoundError('cause-token'),
    }),
  ])('preserves $name class, message and fields across a wire copy', async (error) => {
    const outcome = structuredClone(
      await captureInvocationOutcome(async () => {
        throw error;
      })
    );
    expect(outcome.ok).toBe(false);
    let restored: unknown;
    try {
      unwrapInvocationOutcome(outcome);
    } catch (err) {
      restored = err;
    }
    expect(restored).toBeInstanceOf(error.constructor);
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key !== 'cause')
        expect(Reflect.get(restored as Error, key)).toEqual(
          Reflect.get(error, key)
        );
    }
    expect((restored as Error).message).toBe(error.message);
    expect((restored as Error).stack).toBe(error.stack);
    if (error.cause) {
      expect((restored as Error).cause).toBeInstanceOf(HookNotFoundError);
      expect(
        (restored as Error & { cause: HookNotFoundError }).cause.token
      ).toBe('cause-token');
    }
  });

  it('does not confuse error-looking return values with failures', async () => {
    const value = { ok: false, error: { name: 'HookNotFoundError' } };
    expect(
      unwrapInvocationOutcome(await captureInvocationOutcome(async () => value))
    ).toBe(value);
    expect(
      unwrapInvocationOutcome(
        await captureInvocationOutcome(async () => undefined)
      )
    ).toBeUndefined();
  });

  it('bounds circular diagnostics and ignores prototype mutation fields', () => {
    const error = new WorkflowWorldError('failure');
    Object.defineProperty(error, 'cause', { value: error, configurable: true });
    Object.defineProperty(error, '__proto__', {
      value: { injected: true },
      enumerable: true,
    });
    const wire = serializeWorkflowError(error);
    expect(wire.cause?.message).toContain('Circular');
    const restored = deserializeWorkflowError(wire);
    expect(restored).toBeInstanceOf(WorkflowWorldError);
    expect(restored).not.toHaveProperty('injected');
  });

  it('normalizes unknown thrown values and unknown error classes', async () => {
    const outcome = await captureInvocationOutcome(async () => {
      throw 'failed';
    });
    expect(() => unwrapInvocationOutcome(outcome)).toThrow('failed');
    const unknown = Object.assign(new Error('custom'), {
      name: 'CustomError',
      code: 'CUSTOM',
    });
    const restored = deserializeWorkflowError(serializeWorkflowError(unknown));
    expect(restored).toBeInstanceOf(Error);
    expect(restored).toMatchObject({
      name: 'CustomError',
      message: 'custom',
      code: 'CUSTOM',
    });
  });

  it('preserves non-Error causes and rejects malformed wire outcomes', () => {
    const error = new WorkflowWorldError('failed', {
      cause: { reason: 'unavailable' },
    });
    expect(
      deserializeWorkflowError(serializeWorkflowError(error)).cause
    ).toEqual({ reason: 'unavailable' });
    for (const value of [
      null,
      {},
      { ok: true },
      { ok: false, error: { name: 'Error' } },
    ]) {
      expect(() => unwrapInvocationOutcome(value)).toThrow(
        'outcome is unknown'
      );
    }
  });
});
