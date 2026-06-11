import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_SET_ATTRIBUTES } from '../symbols.js';
import { experimental_setAttributes } from './set-attributes.js';

describe('workflow.experimental_setAttributes', () => {
  const dispatchCalls: Array<{
    changes: Array<{ key: string; value: string | null }>;
    options: { allowReservedAttributes?: boolean } | undefined;
  }> = [];

  beforeEach(() => {
    dispatchCalls.length = 0;
    (globalThis as Record<symbol, unknown>)[WORKFLOW_SET_ATTRIBUTES] = vi.fn(
      async (
        changes: Array<{ key: string; value: string | null }>,
        options?: { allowReservedAttributes?: boolean }
      ) => {
        dispatchCalls.push({ changes, options });
      }
    );
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_SET_ATTRIBUTES];
  });

  it('dispatches normalized changes through the native attribute primitive', async () => {
    await experimental_setAttributes({ phase: 'init', orderId: 'ord_1' });
    expect(dispatchCalls).toEqual([
      {
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

  it('throws FatalError when the workflow runtime has not initialized attribute dispatch', async () => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_SET_ATTRIBUTES];
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

  it('dispatches reserved-prefix keys when allowReservedAttributes opt-in is set, and forwards the flag', async () => {
    await experimental_setAttributes(
      { '$framework.kind': 'agent' },
      { allowReservedAttributes: true }
    );
    expect(dispatchCalls).toEqual([
      {
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
