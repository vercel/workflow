import {
  ATTRIBUTE_VALUE_MAX_BYTES,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../step/context-storage.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

/**
 * `start({ retention })` is the typed spelling of the reserved `$retention`
 * attribute. The World reads it when the run reaches a terminal state to
 * decide how long user data is kept; the SDK only has to seed it, and to keep
 * `'default'` indistinguishable from omission.
 */
describe('start() retention', () => {
  let eventsCreate: ReturnType<typeof vi.fn>;
  let queue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventsCreate = vi.fn().mockImplementation((runId) =>
      Promise.resolve({
        run: { runId: runId ?? 'wrun_x', status: 'pending' },
      })
    );
    queue = vi.fn().mockResolvedValue(undefined);
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
      events: { create: eventsCreate },
      runs: { get: vi.fn() },
      queue,
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const wf = (id: string) =>
    Object.assign(() => Promise.resolve('ok'), { workflowId: id });

  /** Attributes seeded onto the run_created event for the first start(). */
  function seededAttributes(): Record<string, string> | undefined {
    return eventsCreate.mock.calls[0]?.[1]?.eventData?.attributes;
  }

  /** Whether the run_created event opted into the reserved namespace. */
  function seededAllowReserved(): boolean | undefined {
    return eventsCreate.mock.calls[0]?.[1]?.eventData?.allowReservedAttributes;
  }

  it('seeds $retention and opts into the reserved namespace', async () => {
    await start(wf('test-workflow'), [], { retention: 'none' });

    expect(seededAttributes()).toEqual({ $retention: 'none' });
    // Without this the server rejects the reserved key with a 400.
    expect(seededAllowReserved()).toBe(true);
    // Must also ride the resilient-start queue input, or a run created
    // through that path silently loses the retention preference.
    expect(queue.mock.calls[0]?.[1]?.runInput?.attributes).toEqual({
      $retention: 'none',
    });
  });

  it("writes nothing for 'default', matching omission exactly", async () => {
    await start(wf('test-workflow'), [], { retention: 'default' });
    const withDefault = seededAttributes();

    eventsCreate.mockClear();
    await start(wf('test-workflow'), []);

    expect(withDefault).toBeUndefined();
    expect(seededAttributes()).toBeUndefined();
  });

  it('passes a custom World value through untouched', async () => {
    await start(wf('test-workflow'), [], { retention: '90d' });

    expect(seededAttributes()).toEqual({ $retention: '90d' });
  });

  it('keeps caller attributes and lineage alongside retention', async () => {
    await contextStorage.run(
      {
        stepMetadata: {
          stepName: 'start',
          stepId: 'step_1',
          stepStartedAt: new Date(),
          attempt: 1,
        },
        workflowMetadata: {
          workflowName: 'parent',
          workflowRunId: 'wrun_parent',
          workflowStartedAt: new Date(),
          url: 'http://localhost:3000',
          features: { encryption: false },
        },
        rootRunId: 'wrun_root',
        ops: [],
      } as any,
      () =>
        start(wf('child-workflow'), [], {
          attributes: { tenant: 't1' },
          retention: 'none',
        })
    );

    expect(seededAttributes()).toEqual({
      $rootRunId: 'wrun_root',
      $parentRunId: 'wrun_parent',
      tenant: 't1',
      $retention: 'none',
    });
  });

  it('lets the option win over a hand-written $retention attribute', async () => {
    await start(wf('test-workflow'), [], {
      attributes: { $retention: 'default' },
      allowReservedAttributes: true,
      retention: 'none',
    });

    expect(seededAttributes()).toEqual({ $retention: 'none' });
  });

  it('still rejects a hand-written $retention without the escape hatch', async () => {
    await expect(
      start(wf('test-workflow'), [], { attributes: { $retention: 'none' } })
    ).rejects.toThrow(/reserved prefix/);
  });

  it('rejects retention on a World that predates attributes', async () => {
    await expect(
      start(wf('test-workflow'), [], {
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES - 1,
        retention: 'none',
      })
    ).rejects.toThrow(/spec version 4 or later/);
  });

  it("ignores 'default' on a World that predates attributes", async () => {
    // 'default' is a no-op, so it must not turn an otherwise-valid start()
    // on an old World into an error.
    await start(wf('test-workflow'), [], {
      specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES - 1,
      retention: 'default',
    });

    expect(seededAttributes()).toBeUndefined();
  });

  it('rejects a custom value that exceeds the attribute value limit', async () => {
    await expect(
      start(wf('test-workflow'), [], {
        retention: 'x'.repeat(ATTRIBUTE_VALUE_MAX_BYTES + 1),
      })
    ).rejects.toThrow(/exceeds limit/);
  });

  it('rejects an empty retention value', async () => {
    await expect(
      start(wf('test-workflow'), [], { retention: '' })
    ).rejects.toThrow(/non-empty string/);
  });
});
