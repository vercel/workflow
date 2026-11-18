import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorLog } from './logger.js';

describe('operatorLog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prefixes a notice once and passes the rest of the arguments through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    operatorLog.warn('runs no jobs');
    operatorLog.warn('[postgres world] already prefixed');
    operatorLog.warn('[world-postgres] prefixed the other way');
    const cause = new Error('boom');
    operatorLog.error('failed to start', cause);
    expect(warn.mock.calls).toEqual([
      ['[postgres world] runs no jobs'],
      ['[postgres world] already prefixed'],
      ['[world-postgres] prefixed the other way'],
    ]);
    expect(error.mock.calls).toEqual([
      ['[postgres world] failed to start', cause],
    ]);
  });

  it("is silent in the CLI's JSON mode", () => {
    vi.stubEnv('WORKFLOW_JSON_MODE', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    operatorLog.warn('runs no jobs');
    operatorLog.error('failed to start');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
