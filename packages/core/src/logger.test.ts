import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDebug = process.env.DEBUG;

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('./package-require.js');
  });

  afterEach(() => {
    process.env.DEBUG = originalDebug;

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
    vi.doMock('./package-require.js', () => ({
      getCoreRuntimeRequire: () => runtimeRequire,
    }));
    process.env.DEBUG = 'workflow:';

    const { runtimeLogger } = await import('./logger.js');

    runtimeLogger.debug('hello');

    expect(runtimeRequire).toHaveBeenCalledWith('debug');
    expect(debugFactory).toHaveBeenCalledWith('workflow:runtime');
    expect(baseLogger.extend).toHaveBeenCalledWith('debug');
    expect(extendedLogger).toHaveBeenCalledWith('hello', undefined);
  });

  it('does not throw when runtime require is unavailable', async () => {
    vi.doMock('./package-require.js', () => ({
      getCoreRuntimeRequire: () => {
        throw new Error('runtime require unavailable');
      },
    }));
    process.env.DEBUG = 'workflow:';

    const { runtimeLogger } = await import('./logger.js');

    expect(() => runtimeLogger.debug('hello')).not.toThrow();
  });
});
