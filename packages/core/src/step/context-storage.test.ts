import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';

const CONTEXT_STORAGE_SYMBOL = Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE');

describe('contextStorage singleton', () => {
  it('returns the same AsyncLocalStorage instance across multiple imports', async () => {
    // Import the module twice (simulating what bundlers might do)
    const mod1 = await import('./context-storage.js');
    const mod2 = await import('./context-storage.js');

    expect(mod1.contextStorage).toBe(mod2.contextStorage);
  });

  it('shares the same instance stored on globalThis via Symbol.for()', async () => {
    const { contextStorage } = await import('./context-storage.js');
    const globalInstance = (globalThis as any)[CONTEXT_STORAGE_SYMBOL];

    expect(globalInstance).toBe(contextStorage);
    expect(globalInstance).toBeInstanceOf(AsyncLocalStorage);
  });

  it('preserves context from run() when getStore() is called from a separately-constructed reference', async () => {
    // This simulates the dual-module-instance problem:
    // step-handler sets context via one reference, user code reads via another.
    // With the Symbol.for() singleton fix, both references point to the same instance.
    const { contextStorage } = await import('./context-storage.js');
    const globalInstance = (globalThis as any)[
      CONTEXT_STORAGE_SYMBOL
    ] as AsyncLocalStorage<{ value: string }>;

    let storeFromGlobal: { value: string } | undefined;

    globalInstance.run({ value: 'test-context' }, () => {
      storeFromGlobal = contextStorage.getStore() as any;
    });

    expect(storeFromGlobal).toEqual({ value: 'test-context' });
  });
});
