import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_USE_STEP } from '../symbols.js';
import { setAttributes } from './set-attributes.js';

describe('workflow.setAttributes', () => {
  const dispatchCalls: Array<{
    stepName: string;
    changes: Array<{ key: string; value: string | null }>;
  }> = [];

  beforeEach(() => {
    dispatchCalls.length = 0;
    (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP] = vi.fn(
      (stepName: string) =>
        async (changes: Array<{ key: string; value: string | null }>) => {
          dispatchCalls.push({ stepName, changes });
        }
    );
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP];
  });

  it('dispatches normalized changes through __builtin_set_attributes', async () => {
    await setAttributes({ phase: 'init', orderId: 'ord_1' });
    expect(dispatchCalls).toEqual([
      {
        stepName: '__builtin_set_attributes',
        changes: [
          { key: 'phase', value: 'init' },
          { key: 'orderId', value: 'ord_1' },
        ],
      },
    ]);
  });

  it('translates undefined values into null (unset semantics)', async () => {
    await setAttributes({ phase: 'done', stale: undefined });
    expect(dispatchCalls).toEqual([
      {
        stepName: '__builtin_set_attributes',
        changes: [
          { key: 'phase', value: 'done' },
          { key: 'stale', value: null },
        ],
      },
    ]);
  });

  it('is a no-op for an empty record (no dispatch)', async () => {
    await setAttributes({});
    expect(dispatchCalls).toHaveLength(0);
  });

  it('throws FatalError when the workflow runtime has not initialized useStep', async () => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP];
    await expect(setAttributes({ phase: 'init' })).rejects.toBeInstanceOf(
      FatalError
    );
  });

  it('throws FatalError for reserved-prefix keys before any dispatch', async () => {
    await expect(setAttributes({ $sys: 'x' })).rejects.toBeInstanceOf(
      FatalError
    );
    expect(dispatchCalls).toHaveLength(0);
  });

  it('throws FatalError when called with a non-object', async () => {
    await expect(
      setAttributes(null as unknown as Record<string, string>)
    ).rejects.toBeInstanceOf(FatalError);
    await expect(
      setAttributes([] as unknown as Record<string, string>)
    ).rejects.toBeInstanceOf(FatalError);
  });
});
