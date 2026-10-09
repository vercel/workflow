import { expect, it, vi } from 'vitest';
import {
  captureWaitUntil,
  flushDispatches,
  waitUntilPromises,
} from '../../test-utils/lifecycle-hooks.js';

vi.mock('@vercel/functions', () => ({ waitUntil: captureWaitUntil }));

it('registers, dispatches, and unregisters across independent module instances', async () => {
  waitUntilPromises.length = 0;
  const copyA = await import('./lifecycle-hooks.js');
  vi.resetModules();
  const copyB = await import('./lifecycle-hooks.js');
  expect(copyB.registerLifecycleHooks).not.toBe(copyA.registerLifecycleHooks);
  const first = vi.fn();
  const second = vi.fn();
  const unregisterA = copyA.registerLifecycleHooks({ onRunCompleted: first });
  const unregisterB = copyB.registerLifecycleHooks({ onRunCompleted: second });
  try {
    copyB.dispatchRunCompletedHooks('wrun_copies', 'workflow');
    await flushDispatches();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
    unregisterA();
    copyA.dispatchRunCompletedHooks('wrun_copies_again', 'workflow');
    await flushDispatches(2);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  } finally {
    unregisterA();
    unregisterB();
  }
});
