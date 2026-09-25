import { expect, vi } from 'vitest';

export const waitUntilPromises: Promise<unknown>[] = [];

export function captureWaitUntil(promise: Promise<unknown>): void {
  waitUntilPromises.push(promise);
}

/** Fail if the dynamic waitUntil import never hands off the expected work. */
export async function flushDispatches(expected = 1): Promise<void> {
  await vi.waitFor(() => expect(waitUntilPromises).toHaveLength(expected));
  await Promise.all(waitUntilPromises);
}
