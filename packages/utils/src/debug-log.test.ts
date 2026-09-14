import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugLog, isWorkflowDebugEnabled } from './debug-log.js';

describe('isWorkflowDebugEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is off when DEBUG is unset or empty', () => {
    vi.stubEnv('DEBUG', undefined);
    expect(isWorkflowDebugEnabled()).toBe(false);

    vi.stubEnv('DEBUG', '');
    expect(isWorkflowDebugEnabled()).toBe(false);
  });

  it('accepts the selectors a namespaced logger would match', () => {
    for (const value of [
      'workflow:*',
      '*',
      'workflow:runtime:debug',
      'app:*,workflow:world-vercel:*',
    ]) {
      vi.stubEnv('DEBUG', value);
      expect(isWorkflowDebugEnabled(), value).toBe(true);
    }
  });

  it("ignores another library's DEBUG selector", () => {
    // A user debugging their own package must not be handed the SDK's
    // transport breadcrumbs as well.
    vi.stubEnv('DEBUG', 'express:*');
    expect(isWorkflowDebugEnabled()).toBe(false);
  });

  it('re-reads DEBUG on every call', () => {
    // Worlds are built long after import, so a value captured at module load
    // answers for the wrong moment.
    vi.stubEnv('DEBUG', '');
    expect(isWorkflowDebugEnabled()).toBe(false);

    vi.stubEnv('DEBUG', 'workflow:*');
    expect(isWorkflowDebugEnabled()).toBe(true);
  });
});

describe('debugLog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes nothing at all when DEBUG is off', () => {
    vi.stubEnv('DEBUG', '');
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {})
    );

    debugLog('a breadcrumb', { runId: 'wrun_1' });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('forwards every argument to console.debug under DEBUG', () => {
    vi.stubEnv('DEBUG', 'workflow:*');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const detail = { runId: 'wrun_1' };

    debugLog('a breadcrumb', detail);

    expect(debugSpy).toHaveBeenCalledWith('a breadcrumb', detail);
  });
});
