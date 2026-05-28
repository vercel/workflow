import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  ATTRIBUTE_KEY_MAX_LENGTH,
  AttributeValidationError,
  RESERVED_ATTRIBUTE_KEY_PREFIX,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import { createRun } from '../test-helpers.js';

describe('runs.experimentalSetAttributes (world-local)', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attrs-test-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function newRun() {
    return createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array([1]),
    });
  }

  it('upserts new keys', async () => {
    const run = await newRun();

    const result = await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'phase', value: 'init' },
      { key: 'tenant', value: 't1' },
    ]);

    expect(result.attributes).toEqual({ phase: 'init', tenant: 't1' });
    const refreshed = await storage.runs.get(run.runId);
    expect(refreshed.attributes).toEqual({ phase: 'init', tenant: 't1' });
  });

  it('updates existing keys (merge semantics)', async () => {
    const run = await newRun();
    await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'phase', value: 'init' },
      { key: 'tenant', value: 't1' },
    ]);

    const result = await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'phase', value: 'done' },
    ]);

    expect(result.attributes).toEqual({ phase: 'done', tenant: 't1' });
  });

  it('removes keys when value is null', async () => {
    const run = await newRun();
    await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'phase', value: 'init' },
      { key: 'orderId', value: 'ord_123' },
    ]);

    const result = await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'orderId', value: null },
    ]);

    expect(result.attributes).toEqual({ phase: 'init' });
    expect(result.attributes).not.toHaveProperty('orderId');
  });

  it('applies set and unset in a single call', async () => {
    const run = await newRun();
    await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'stale', value: 'yes' },
    ]);

    const result = await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'stale', value: null },
      { key: 'fresh', value: 'yes' },
    ]);

    expect(result.attributes).toEqual({ fresh: 'yes' });
  });

  it('throws WorkflowRunNotFoundError for unknown run', async () => {
    await expect(
      storage.runs.experimentalSetAttributes!('wrun_doesnotexist', [
        { key: 'phase', value: 'init' },
      ])
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });

  it('rejects keys starting with reserved prefix', async () => {
    const run = await newRun();
    await expect(
      storage.runs.experimentalSetAttributes!(run.runId, [
        { key: `${RESERVED_ATTRIBUTE_KEY_PREFIX}sys`, value: 'x' },
      ])
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it('accepts reserved-prefix keys when allowReservedAttributes is set (framework escape hatch)', async () => {
    const run = await newRun();
    const result = await storage.runs.experimentalSetAttributes!(
      run.runId,
      [
        {
          key: `${RESERVED_ATTRIBUTE_KEY_PREFIX}framework.kind`,
          value: 'agent',
        },
        { key: 'phase', value: 'init' },
      ],
      { allowReservedAttributes: true }
    );
    expect(result.attributes).toEqual({
      [`${RESERVED_ATTRIBUTE_KEY_PREFIX}framework.kind`]: 'agent',
      phase: 'init',
    });

    // Without the flag on a follow-up write, the rejection still
    // fires — the opt-in is per-call, not sticky on the run.
    await expect(
      storage.runs.experimentalSetAttributes!(run.runId, [
        { key: `${RESERVED_ATTRIBUTE_KEY_PREFIX}other`, value: 'x' },
      ])
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it('rejects keys over the max length', async () => {
    const run = await newRun();
    await expect(
      storage.runs.experimentalSetAttributes!(run.runId, [
        { key: 'k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH + 1), value: 'x' },
      ])
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it('rejects values exceeding the byte cap', async () => {
    const run = await newRun();
    await expect(
      storage.runs.experimentalSetAttributes!(run.runId, [
        { key: 'big', value: 'a'.repeat(257) },
      ])
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it('updates at the cap boundary do not falsely trip the limit', async () => {
    const run = await newRun();
    // Fill to exactly the cap.
    const initial = Array.from({ length: 64 }, (_, i) => ({
      key: `k${i}`,
      value: 'v',
    }));
    await storage.runs.experimentalSetAttributes!(run.runId, initial);

    // Updating an existing key (no growth) must succeed even at the cap.
    const result = await storage.runs.experimentalSetAttributes!(run.runId, [
      { key: 'k0', value: 'updated' },
    ]);
    expect(result.attributes.k0).toBe('updated');
    expect(Object.keys(result.attributes)).toHaveLength(64);
  });

  it('repeated identical calls are idempotent', async () => {
    const run = await newRun();
    const changes = [
      { key: 'phase', value: 'init' as string | null },
      { key: 'tenant', value: 't1' as string | null },
    ];

    const first = await storage.runs.experimentalSetAttributes!(
      run.runId,
      changes
    );
    const second = await storage.runs.experimentalSetAttributes!(
      run.runId,
      changes
    );
    const third = await storage.runs.experimentalSetAttributes!(
      run.runId,
      changes
    );

    // All three converge on the same snapshot — second/third are no-op
    // upserts of the same values.
    expect(first.attributes).toEqual({ phase: 'init', tenant: 't1' });
    expect(second.attributes).toEqual(first.attributes);
    expect(third.attributes).toEqual(first.attributes);
  });

  it('rejects when post-merge count exceeds limit', async () => {
    const run = await newRun();
    // Pre-fill to within the cap. The MVP cap is 64.
    const initial = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`,
      value: 'v',
    }));
    await storage.runs.experimentalSetAttributes!(run.runId, initial);

    // Adding 5 new keys would push us over.
    const overflow = Array.from({ length: 5 }, (_, i) => ({
      key: `extra${i}`,
      value: 'v',
    }));
    await expect(
      storage.runs.experimentalSetAttributes!(run.runId, overflow)
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it('serializes concurrent writes to the same run (no lost writes)', async () => {
    const run = await newRun();

    // 20 concurrent writes; each adds a unique key. Per-run mutex must
    // serialize them so all keys land — without it, the read-merge-write
    // race loses some.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        storage.runs.experimentalSetAttributes!(run.runId, [
          { key: `k${i}`, value: `v${i}` },
        ])
      )
    );

    const refreshed = await storage.runs.get(run.runId);
    expect(Object.keys(refreshed.attributes ?? {})).toHaveLength(20);
  });
});
