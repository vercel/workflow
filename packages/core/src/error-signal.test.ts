import { runInNewContext } from 'node:vm';
import {
  FatalError,
  RetryableError,
  WorkflowWorldError,
} from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { errorSignalFields, MAX_ERROR_NAME_LENGTH } from './error-signal.js';

const SECRET = 'Invalid API Key provided: sk_live_do_not_leak';

class StripeAuthenticationError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'StripeAuthenticationError';
  }
}

describe('errorSignalFields', () => {
  it("records an error's class name and HTTP status", () => {
    expect(errorSignalFields(new StripeAuthenticationError(SECRET))).toEqual({
      errorName: 'StripeAuthenticationError',
      errorStatus: 401,
    });
  });

  it('never records the message, the stack or any other property', () => {
    const error = Object.assign(new StripeAuthenticationError(SECRET), {
      code: 'api_key_invalid',
      raw: { message: SECRET },
      cause: new Error(SECRET),
    });
    const fields = errorSignalFields(error);
    expect(Object.keys(fields).sort()).toEqual(['errorName', 'errorStatus']);
    expect(JSON.stringify(fields)).not.toContain('sk_live_do_not_leak');
  });

  it('reads `status` when there is no `statusCode`', () => {
    expect(
      errorSignalFields(new WorkflowWorldError('throttled', { status: 429 }))
    ).toEqual({ errorName: 'WorkflowWorldError', errorStatus: 429 });
    expect(
      errorSignalFields(Object.assign(new Error('x'), { status: 503 }))
    ).toEqual({ errorName: 'Error', errorStatus: 503 });
  });

  it('prefers `statusCode` over `status`', () => {
    expect(
      errorSignalFields(
        Object.assign(new Error('x'), { statusCode: 404, status: 500 })
      )
    ).toMatchObject({ errorStatus: 404 });
  });

  it('records only integer HTTP statuses', () => {
    for (const statusCode of [99, 600, 401.5, Number.NaN, '401', -1]) {
      expect(
        errorSignalFields(Object.assign(new Error('x'), { statusCode }))
      ).toEqual({ errorName: 'Error' });
    }
    expect(
      errorSignalFields(Object.assign(new Error('x'), { statusCode: 100 }))
    ).toMatchObject({ errorStatus: 100 });
    expect(
      errorSignalFields(Object.assign(new Error('x'), { statusCode: 599 }))
    ).toMatchObject({ errorStatus: 599 });
  });

  it('names a subclass that never sets `name` by its constructor', () => {
    class PaymentDeclined extends Error {}
    expect(errorSignalFields(new PaymentDeclined(SECRET))).toEqual({
      errorName: 'PaymentDeclined',
    });
  });

  it('names an error from another realm', () => {
    const error = runInNewContext(
      'class QuotaExceeded extends Error {}; const e = new QuotaExceeded("x"); e.status = 429; e'
    );
    expect(errorSignalFields(error)).toEqual({
      errorName: 'QuotaExceeded',
      errorStatus: 429,
    });
  });

  it("reports a FatalError's cause, which is the error that failed", () => {
    const wrapped = new FatalError(`Step failed after 3 retries: ${SECRET}`);
    (wrapped as Error).cause = new StripeAuthenticationError(SECRET);
    expect(errorSignalFields(wrapped)).toEqual({
      errorName: 'StripeAuthenticationError',
      errorStatus: 401,
    });
  });

  it('reports a FatalError without an error cause as itself', () => {
    expect(errorSignalFields(new FatalError(SECRET))).toEqual({
      errorName: 'FatalError',
    });
    const wrappingString = new FatalError(SECRET);
    (wrappingString as Error).cause = SECRET;
    expect(errorSignalFields(wrappingString)).toEqual({
      errorName: 'FatalError',
    });
  });

  it('does not unwrap other errors with a cause', () => {
    expect(
      errorSignalFields(
        new RetryableError('retry', {}) as Error & { cause?: unknown }
      )
    ).toEqual({ errorName: 'RetryableError' });
    expect(
      errorSignalFields(
        new Error('outer', { cause: new StripeAuthenticationError(SECRET) })
      )
    ).toEqual({ errorName: 'Error' });
  });

  it('stops unwrapping a FatalError cycle', () => {
    const a = new FatalError('a');
    const b = new FatalError('b');
    (a as Error).cause = b;
    (b as Error).cause = a;
    expect(errorSignalFields(a)).toEqual({ errorName: 'FatalError' });
  });

  it('drops a name that is not an identifier, so free text never leaks', () => {
    for (const name of [
      SECRET,
      'Error: boom',
      'Bad\nName',
      '1Error',
      '',
      '   ',
      `E${'x'.repeat(MAX_ERROR_NAME_LENGTH)}`,
    ]) {
      const error = Object.assign(new Error(SECRET), { name, statusCode: 500 });
      expect(errorSignalFields(error)).toEqual({ errorStatus: 500 });
    }
    expect(
      errorSignalFields(
        Object.assign(new Error('x'), {
          name: `E${'x'.repeat(MAX_ERROR_NAME_LENGTH - 1)}`,
        })
      ).errorName
    ).toHaveLength(MAX_ERROR_NAME_LENGTH);
    expect(
      errorSignalFields(
        Object.assign(new Error('x'), { name: 'Stripe.errors.CardError' })
      )
    ).toEqual({ errorName: 'Stripe.errors.CardError' });
  });

  it('reads a thrown plain object, without inventing a class name', () => {
    expect(errorSignalFields({ name: 'ApiError', status: 502 })).toEqual({
      errorName: 'ApiError',
      errorStatus: 502,
    });
    expect(errorSignalFields({ name: 'Error' })).toEqual({
      errorName: 'Error',
    });
    expect(errorSignalFields({ message: SECRET })).toEqual({});
  });

  it('records nothing for a thrown non-object', () => {
    for (const value of [SECRET, 42, null, undefined, true]) {
      expect(errorSignalFields(value)).toEqual({});
    }
  });

  it('never throws, whatever the thrown value does', () => {
    const throwingName = new Error('x');
    Object.defineProperty(throwingName, 'name', {
      get() {
        throw new Error('name getter');
      },
    });
    expect(errorSignalFields(throwingName)).toEqual({});

    const throwingStatus = new Error('x');
    Object.defineProperty(throwingStatus, 'statusCode', {
      get() {
        throw new Error('status getter');
      },
    });
    expect(() => errorSignalFields(throwingStatus)).not.toThrow();

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(errorSignalFields(revoked.proxy)).toEqual({});
  });
});
