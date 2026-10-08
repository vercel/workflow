import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';
import { reportActionableApiError } from './errors.js';

const logged = () =>
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

// The set three call sites depend on: handleApiError composes it, listSleeps
// uses it to decide what not to degrade past, and cancel has no fallback at
// all. A class dropped from here goes silent in all three.
describe('reportActionableApiError', () => {
  it('reports an argument the World rejected locally', () => {
    const error = Object.assign(
      new Error(
        'runs.list: pagination.limit must be an integer between 1 and 100 (received 500)'
      ),
      { code: 'INVALID_ARGUMENT', field: 'pagination.limit' }
    );
    const error_ = logged();

    expect(reportActionableApiError(error)).toBe(true);
    expect(error_.mock.calls.flat().join(' ')).toContain('between 1 and 100');
  });

  it('reports the plan gate with its upgrade message', () => {
    const error = { status: 402, code: 'observability-upgrade-required' };
    const error_ = logged();

    expect(reportActionableApiError(error)).toBe(true);
    expect(error_.mock.calls.flat().join(' ')).toContain('Observability Plus');
  });

  // Only meaningful against the Vercel backend, which is the one that answers
  // 403 for a project the token cannot read.
  it('reports a Vercel 403 only when that is the backend', () => {
    const error = { status: 403 };
    const error_ = logged();

    expect(reportActionableApiError(error, 'vercel')).toBe(true);
    expect(error_).toHaveBeenCalled();

    error_.mockClear();
    expect(reportActionableApiError(error, 'local')).toBe(false);
    expect(error_).not.toHaveBeenCalled();
  });

  // Availability failures are what listSleeps degrades on, so they must not
  // be claimed here.
  it.each([
    ['a transport failure', new Error('fetch failed')],
    ['a server error', { status: 503 }],
    ['a plain 400', { status: 400 }],
    ['a non-object', 'nope'],
  ])('leaves %s to the caller', (_label, error) => {
    const error_ = logged();
    expect(reportActionableApiError(error)).toBe(false);
    expect(error_).not.toHaveBeenCalled();
  });
});
