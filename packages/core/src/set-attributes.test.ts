import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotInWorkflowOrStepContextError } from './context-errors.js';
import { setAttributes } from './set-attributes.js';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';

// `setAttributesStep` resolves the World via `getWorldLazy`. We mock that
// so tests don't try to load the real world initializer chain (which
// pulls in world-local / world-vercel).
const dispatchCalls: Array<{ runId: string; changes: any[] }> = [];

vi.mock('./runtime/get-world-lazy.js', () => ({
  getWorldLazy: vi.fn(async () => mockedWorld),
}));

let supportsAttributes = true;
const mockedWorld: any = {
  runs: {
    get experimentalSetAttributes() {
      if (!supportsAttributes) return undefined;
      return async (runId: string, changes: any[]) => {
        dispatchCalls.push({ runId, changes });
        return { attributes: {} };
      };
    },
  },
};

function withWorkflowContext<T>(runId: string, fn: () => T): T {
  (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] = { workflowRunId: runId };
  try {
    return fn();
  } finally {
    delete (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL];
  }
}

function withStepContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run(
    {
      stepMetadata: {} as any,
      workflowMetadata: {
        workflowRunId: runId,
      } as any,
      ops: [],
    },
    fn
  );
}

describe('setAttributes', () => {
  beforeEach(() => {
    dispatchCalls.length = 0;
    supportsAttributes = true;
  });

  afterEach(() => {
    delete (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL];
  });

  describe('context detection', () => {
    it('dispatches when called inside a step context', async () => {
      await withStepContext('wrun_step', async () => {
        await setAttributes({ phase: 'init' });
      });
      expect(dispatchCalls).toEqual([
        { runId: 'wrun_step', changes: [{ key: 'phase', value: 'init' }] },
      ]);
    });

    it('dispatches when called inside a workflow VM context', async () => {
      await withWorkflowContext('wrun_workflow', () =>
        setAttributes({ phase: 'init' })
      );
      expect(dispatchCalls).toEqual([
        { runId: 'wrun_workflow', changes: [{ key: 'phase', value: 'init' }] },
      ]);
    });

    it('throws NotInWorkflowOrStepContextError when called outside both', async () => {
      await expect(setAttributes({ phase: 'init' })).rejects.toBeInstanceOf(
        NotInWorkflowOrStepContextError
      );
    });
  });

  describe('normalization', () => {
    it('translates undefined values into null on the wire (unset)', async () => {
      await withStepContext('wrun_x', async () => {
        await setAttributes({ phase: 'done', stale: undefined });
      });
      expect(dispatchCalls).toEqual([
        {
          runId: 'wrun_x',
          changes: [
            { key: 'phase', value: 'done' },
            { key: 'stale', value: null },
          ],
        },
      ]);
    });

    it('is a no-op for an empty record (no dispatch, no warning)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await withStepContext('wrun_x', async () => {
          await setAttributes({});
        });
        expect(dispatchCalls).toHaveLength(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('validation', () => {
    it('throws FatalError for keys starting with reserved prefix', async () => {
      await withStepContext('wrun_x', async () => {
        await expect(setAttributes({ $sys: 'x' })).rejects.toBeInstanceOf(
          FatalError
        );
      });
      expect(dispatchCalls).toHaveLength(0);
    });

    it('throws FatalError for empty keys', async () => {
      await withStepContext('wrun_x', async () => {
        await expect(setAttributes({ '': 'x' })).rejects.toBeInstanceOf(
          FatalError
        );
      });
    });

    it('throws FatalError for values exceeding 256 bytes', async () => {
      await withStepContext('wrun_x', async () => {
        await expect(
          setAttributes({ k: 'a'.repeat(257) })
        ).rejects.toBeInstanceOf(FatalError);
      });
    });

    it('throws FatalError when called with a non-object', async () => {
      await withStepContext('wrun_x', async () => {
        await expect(
          setAttributes(null as unknown as Record<string, string>)
        ).rejects.toBeInstanceOf(FatalError);
        await expect(
          setAttributes('hi' as unknown as Record<string, string>)
        ).rejects.toBeInstanceOf(FatalError);
        await expect(
          setAttributes([] as unknown as Record<string, string>)
        ).rejects.toBeInstanceOf(FatalError);
      });
    });
  });

  describe('feature detection', () => {
    it('no-ops with a single warning when world lacks experimentalSetAttributes', async () => {
      supportsAttributes = false;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await withStepContext('wrun_x', async () => {
          await setAttributes({ phase: 'init' });
          await setAttributes({ phase: 'done' });
          await setAttributes({ tenant: 't1' });
        });
        expect(dispatchCalls).toHaveLength(0);
        // Single warning across multiple unsupported calls — the helper
        // dedupes so callers don't flood logs.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain(
          'does not implement experimentalSetAttributes'
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
