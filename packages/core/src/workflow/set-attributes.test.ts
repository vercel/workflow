import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_USE_STEP } from '../symbols.js';
import { experimental_setAttributes } from './set-attributes.js';

describe('workflow.experimental_setAttributes', () => {
  const dispatchCalls: Array<{
    stepName: string;
    changes: Array<{ key: string; value: string | null }>;
    options: { allowReservedAttributes?: boolean } | undefined;
  }> = [];

  beforeEach(() => {
    dispatchCalls.length = 0;
    (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP] = vi.fn(
      (stepName: string) =>
        async (
          changes: Array<{ key: string; value: string | null }>,
          options?: { allowReservedAttributes?: boolean }
        ) => {
          dispatchCalls.push({ stepName, changes, options });
        }
    );
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP];
  });

  it('dispatches normalized changes through __builtin_set_attributes', async () => {
    await experimental_setAttributes({ phase: 'init', orderId: 'ord_1' });
    expect(dispatchCalls).toEqual([
      {
        stepName: '__builtin_set_attributes',
        changes: [
          { key: 'phase', value: 'init' },
          { key: 'orderId', value: 'ord_1' },
        ],
        options: {},
      },
    ]);
  });

  it('translates undefined values into null (unset semantics)', async () => {
    await experimental_setAttributes({ phase: 'done', stale: undefined });
    expect(dispatchCalls).toEqual([
      {
        stepName: '__builtin_set_attributes',
        changes: [
          { key: 'phase', value: 'done' },
          { key: 'stale', value: null },
        ],
        options: {},
      },
    ]);
  });

  it('is a no-op for an empty record (no dispatch)', async () => {
    await experimental_setAttributes({});
    expect(dispatchCalls).toHaveLength(0);
  });

  it('throws FatalError when the workflow runtime has not initialized useStep', async () => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP];
    await expect(
      experimental_setAttributes({ phase: 'init' })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('throws FatalError for reserved-prefix keys before any dispatch', async () => {
    await expect(
      experimental_setAttributes({ $sys: 'x' })
    ).rejects.toBeInstanceOf(FatalError);
    expect(dispatchCalls).toHaveLength(0);
  });

  it('dispatches reserved-prefix keys when allowReservedAttributes opt-in is set, and forwards the flag to the step', async () => {
    await experimental_setAttributes(
      { '$framework.kind': 'agent' },
      { allowReservedAttributes: true }
    );
    expect(dispatchCalls).toEqual([
      {
        stepName: '__builtin_set_attributes',
        changes: [{ key: '$framework.kind', value: 'agent' }],
        options: { allowReservedAttributes: true },
      },
    ]);
  });

  it('still rejects reserved-prefix keys when allowReservedAttributes is explicitly false', async () => {
    await expect(
      experimental_setAttributes(
        { '$framework.kind': 'agent' },
        { allowReservedAttributes: false }
      )
    ).rejects.toBeInstanceOf(FatalError);
    expect(dispatchCalls).toHaveLength(0);
  });

  it('throws FatalError when called with a non-object', async () => {
    await expect(
      experimental_setAttributes(null as unknown as Record<string, string>)
    ).rejects.toBeInstanceOf(FatalError);
    await expect(
      experimental_setAttributes([] as unknown as Record<string, string>)
    ).rejects.toBeInstanceOf(FatalError);
  });
});
