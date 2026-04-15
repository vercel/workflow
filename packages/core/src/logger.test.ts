import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDebug = process.env.DEBUG;
const originalRequire = (globalThis as Record<string, unknown>).require;

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DEBUG = originalDebug;

    if (originalRequire === undefined) {
      delete (globalThis as Record<string, unknown>).require;
    } else {
      (globalThis as Record<string, unknown>).require = originalRequire;
    }

    vi.restoreAllMocks();
  });

  it('loads debug lazily from the runtime require when DEBUG is enabled', async () => {
    const extendedLogger = vi.fn() as unknown as ((
      ...args: unknown[]
    ) => void) & {
      enabled?: boolean;
    };
    extendedLogger.enabled = true;

    const baseLogger = Object.assign(vi.fn(), {
      extend: vi.fn(() => extendedLogger),
    });
    const debugFactory = vi.fn(() => baseLogger);
    const runtimeRequire = vi.fn(() => ({ default: debugFactory }));
    (globalThis as Record<string, unknown>).require = runtimeRequire;
    process.env.DEBUG = 'workflow:';

    const { runtimeLogger } = await import('./logger.js');

    runtimeLogger.debug('hello');

    expect(runtimeRequire).toHaveBeenCalledWith('debug');
    expect(debugFactory).toHaveBeenCalledWith('workflow:runtime');
    expect(baseLogger.extend).toHaveBeenCalledWith('debug');
    expect(extendedLogger).toHaveBeenCalledWith('hello', undefined);
  });

  it('does not throw when runtime require is unavailable', async () => {
    delete (globalThis as Record<string, unknown>).require;
    process.env.DEBUG = 'workflow:';

    const { runtimeLogger } = await import('./logger.js');

    expect(() => runtimeLogger.debug('hello')).not.toThrow();
  });
});
