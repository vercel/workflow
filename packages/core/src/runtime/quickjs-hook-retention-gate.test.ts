import { FatalError } from '@workflow/errors';
import type { WorldCapabilities } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { assertHookRetentionSupported } from './quickjs-entrypoint.js';
import type { PendingOperation } from './quickjs-runtime.js';

/**
 * Host-side capability gate for retained Hooks on the QuickJS engine.
 * Mirrors the node engine's check in workflow/hook.ts: a World without
 * hookRetention.active must reject a retained Hook BEFORE registration,
 * not silently persist it without its retention deadline.
 */
describe('assertHookRetentionSupported', () => {
  const retainedHook: PendingOperation = {
    type: 'hook',
    correlationId: 'hook_01TEST',
    token: 'tok',
    tokenRetentionUntil: Date.now() + 60_000,
    isWebhook: false,
    hasCreatedEvent: false,
  } as PendingOperation;

  const plainHook: PendingOperation = {
    type: 'hook',
    correlationId: 'hook_02TEST',
    token: 'tok2',
    isWebhook: false,
    hasCreatedEvent: false,
  } as PendingOperation;

  const activeCaps: WorldCapabilities = { hookRetention: { active: true } };

  it('passes retained hooks on a world with active hookRetention', () => {
    expect(() =>
      assertHookRetentionSupported([retainedHook], activeCaps)
    ).not.toThrow();
  });

  it('throws FatalError for a retained hook when capabilities are absent', () => {
    expect(() =>
      assertHookRetentionSupported([retainedHook], undefined)
    ).toThrow(FatalError);
    expect(() =>
      assertHookRetentionSupported([retainedHook], undefined)
    ).toThrow(
      'The configured World does not support `experimental_minRetention` for Hooks.'
    );
  });

  it('throws when hookRetention is declared but inactive', () => {
    expect(() =>
      assertHookRetentionSupported([retainedHook], {
        hookRetention: { active: false },
      })
    ).toThrow(FatalError);
  });

  it('ignores hooks without a retention deadline', () => {
    expect(() =>
      assertHookRetentionSupported([plainHook], undefined)
    ).not.toThrow();
  });

  it('ignores non-hook operations', () => {
    const waitOp = {
      type: 'wait',
      correlationId: 'wait_01TEST',
      resumeAt: new Date().toISOString(),
      hasCreatedEvent: false,
    } as unknown as PendingOperation;
    expect(() =>
      assertHookRetentionSupported([waitOp], undefined)
    ).not.toThrow();
  });
});
