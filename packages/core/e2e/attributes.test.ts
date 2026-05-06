/**
 * E2E tests for the workflow attributes API (V1).
 *
 * These tests are currently SKIPPED — they exercise APIs that do not yet
 * exist (`setAttribute`, `setAttributes`, `getAttribute`, `getAttributes`,
 * `start({ attributes })`, `world.runs.list({ attributes })`,
 * `world.runs.listAttributeKeys`, `world.runs.listAttributeValues`).
 *
 * They are committed in this draft PR so the test cases can be reviewed
 * alongside the plan and docs *before* implementation begins. Each `.skip`
 * should be removed (or the entire `describe.skip` flipped to `describe`)
 * once the corresponding piece of the V1 plan lands.
 *
 * Run locally (once unskipped):
 *
 *   cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev \
 *     > /tmp/nextjs-dev.log 2>&1 &
 *   sleep 15
 *   DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *     pnpm vitest run packages/core/e2e/attributes.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../src/runtime';
import { getWorld, start as rawStart } from '../src/runtime';
import {
  getWorkflowMetadata,
  setupRunTracking,
  setupWorld,
  trackRun,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  const run = await rawStart<T>(...args);
  trackRun(run);
  return run;
}

async function attrWorkflow(fn: string) {
  return getWorkflowMetadata(deploymentUrl, 'workflows/9_attributes.ts', fn);
}

beforeAll(async () => {
  setupWorld(deploymentUrl);
});

beforeEach((ctx) => {
  setupRunTracking(ctx.task.name);
});

afterAll(() => {
  // No e2e metadata writes here — the main e2e.test.ts owns that pipeline.
});

// ============================================================================
// All cases in this file correspond directly to the "Test plan" section of
// the V1 plan in PR #1933. They will be flipped on as implementation lands.
// ============================================================================

describe.skip('attributes (V1)', { timeout: 60_000 }, () => {
  // --------------------------------------------------------------------------
  // setAttribute / getAttribute round-trip from a workflow + step
  // --------------------------------------------------------------------------
  it('round-trips a single attribute through workflow + step writes', async () => {
    const run = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_123',
    ]);

    const result = (await run.returnValue) as {
      tenant: string | undefined;
      stepView: Record<string, string>;
      orderIdAfterStep: string | undefined;
      final: Record<string, string>;
    };

    // No initial attributes were set on this run — tenant comes back undefined.
    expect(result.tenant).toBeUndefined();

    // Step body saw its own writes (read-your-writes).
    expect(result.stepView).toMatchObject({
      orderId: 'ord_123',
      stepKind: 'process',
      region: 'us-east-1',
    });

    // Workflow body resumed after the step and observed the step's writes.
    expect(result.orderIdAfterStep).toBe('ord_123');

    // Final snapshot reflects the workflow's last setAttribute('phase', 'done')
    // and the unset of `region`.
    expect(result.final).toEqual({
      orderId: 'ord_123',
      stepKind: 'process',
      phase: 'done',
    });

    // The run snapshot persisted by the world matches the workflow's final view.
    const world = await getWorld();
    const persisted = await world.runs.get(run.runId);
    expect(persisted.attributes).toEqual({
      orderId: 'ord_123',
      stepKind: 'process',
      phase: 'done',
    });
  });

  // --------------------------------------------------------------------------
  // setAttributes batch: one event with multiple `changes` entries
  // --------------------------------------------------------------------------
  it('emits a single attr_set event for setAttributes with multiple keys', async () => {
    const run = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_456',
    ]);
    await run.returnValue;

    const world = await getWorld();
    const { data: events } = await world.events.list({
      runId: run.runId,
      pagination: { limit: 100 },
    });

    // The step's setAttributes({ stepKind, region }) call should land as a
    // single attr_set event whose eventData.changes has length 2.
    const stepBatch = events.find(
      (e: any) =>
        e.eventType === 'attr_set' &&
        e.eventData?.writer?.type === 'step' &&
        Array.isArray(e.eventData?.changes) &&
        e.eventData.changes.length === 2
    );
    expect(stepBatch).toBeDefined();
    expect(
      stepBatch?.eventData?.changes?.map((c: any) => c.key).sort()
    ).toEqual(['region', 'stepKind']);
  });

  // --------------------------------------------------------------------------
  // start({ attributes }) — initial attributes carried on run_created
  // --------------------------------------------------------------------------
  it('materializes initial attributes from start() onto the run with no attr_set event', async () => {
    const run = await start(
      await attrWorkflow('attributesWorkflow'),
      ['ord_789'],
      // TODO(attributes): drop this cast once start() options accept attributes.
      { attributes: { tenant: 't_acme' } } as any
    );

    const result = (await run.returnValue) as {
      tenant: string | undefined;
      final: Record<string, string>;
    };

    expect(result.tenant).toBe('t_acme');
    expect(result.final).toMatchObject({ tenant: 't_acme', phase: 'done' });

    // No attr_set event should have been emitted for the initial set —
    // it lives on run_created.eventData.attributes.
    const world = await getWorld();
    const { data: events } = await world.events.list({
      runId: run.runId,
      pagination: { limit: 100 },
    });
    const runCreated = events.find((e: any) => e.eventType === 'run_created');
    expect(runCreated?.eventData?.attributes).toEqual({ tenant: 't_acme' });

    const initialAttrSets = events.filter(
      (e: any) =>
        e.eventType === 'attr_set' &&
        e.eventData?.changes?.some((c: any) => c.key === 'tenant')
    );
    // The workflow body never writes `tenant`, so no attr_set should mention it.
    expect(initialAttrSets).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Writer attribution: workflow vs step, including step attempt counter
  // --------------------------------------------------------------------------
  it('records writer.type=workflow for workflow-emitted writes', async () => {
    const run = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_w',
    ]);
    await run.returnValue;

    const world = await getWorld();
    const { data: events } = await world.events.list({
      runId: run.runId,
      pagination: { limit: 100 },
    });

    const phaseInit = events.find(
      (e: any) =>
        e.eventType === 'attr_set' &&
        e.eventData?.changes?.some(
          (c: any) => c.key === 'phase' && c.value === 'init'
        )
    );
    expect(phaseInit?.eventData?.writer).toEqual({ type: 'workflow' });
  });

  it('records writer.type=step with stepId+attempt for step writes', async () => {
    const run = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_s',
    ]);
    await run.returnValue;

    const world = await getWorld();
    const { data: events } = await world.events.list({
      runId: run.runId,
      pagination: { limit: 100 },
    });

    const stepWrite = events.find(
      (e: any) =>
        e.eventType === 'attr_set' && e.eventData?.writer?.type === 'step'
    );
    expect(stepWrite).toBeDefined();
    expect(stepWrite?.eventData?.writer).toMatchObject({
      type: 'step',
      stepId: expect.any(String),
      attempt: 1,
    });
  });

  it('records distinct attempts when a step retries', async () => {
    const run = await start(await attrWorkflow('attributesRetryWorkflow'), []);
    const final = (await run.returnValue) as Record<string, string>;

    // Both attempts should have written a key with their attempt number.
    expect(final).toMatchObject({
      'attemptedAt-1': expect.any(String),
      'attemptedAt-2': expect.any(String),
    });

    const world = await getWorld();
    const { data: events } = await world.events.list({
      runId: run.runId,
      pagination: { limit: 100 },
    });

    const attempts = events
      .filter(
        (e: any) =>
          e.eventType === 'attr_set' && e.eventData?.writer?.type === 'step'
      )
      .map((e: any) => e.eventData?.writer?.attempt as number)
      .sort();

    expect(attempts).toEqual([1, 2]);
  });

  // --------------------------------------------------------------------------
  // Replay determinism: a workflow that calls getAttribute multiple times
  // sees the same value across replays.
  // --------------------------------------------------------------------------
  it('is deterministic across replays', async () => {
    // Two independent runs of the same workflow with identical inputs
    // should produce identical final attribute snapshots. (The runtime
    // replays from the event log on resume; this asserts that the rebuilt
    // attributes view matches the original.)
    const r1 = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_det',
    ]);
    const r2 = await start(await attrWorkflow('attributesWorkflow'), [
      'ord_det',
    ]);

    const v1 = (await r1.returnValue) as { final: Record<string, string> };
    const v2 = (await r2.returnValue) as { final: Record<string, string> };

    expect(v1.final).toEqual(v2.final);
  });

  // --------------------------------------------------------------------------
  // runs.list({ attributes }) — AND-combined exact-match filter
  // --------------------------------------------------------------------------
  it('filters runs by a single attribute via runs.list', async () => {
    const run = await start(
      await attrWorkflow('attributesWorkflow'),
      ['ord_filter_one'],
      { attributes: { tenant: 't_filter' } } as any
    );
    await run.returnValue;

    const world = await getWorld();
    const { data: matched } = await world.runs.list({
      // TODO(attributes): drop the cast once ListWorkflowRunsParams adds
      // the `attributes` field.
      attributes: { tenant: 't_filter' },
    } as any);

    expect(matched.some((r) => r.runId === run.runId)).toBe(true);
  });

  it('AND-combines multiple attribute filters on runs.list', async () => {
    const matchingRun = await start(
      await attrWorkflow('attributesWorkflow'),
      ['ord_match'],
      { attributes: { tenant: 't_and', region: 'eu-west-1' } } as any
    );
    const nonMatchingRun = await start(
      await attrWorkflow('attributesWorkflow'),
      ['ord_nope'],
      { attributes: { tenant: 't_and', region: 'us-east-1' } } as any
    );
    await matchingRun.returnValue;
    await nonMatchingRun.returnValue;

    const world = await getWorld();
    const { data: matched } = await world.runs.list({
      attributes: { tenant: 't_and', region: 'eu-west-1' },
    } as any);

    const ids = matched.map((r) => r.runId);
    expect(ids).toContain(matchingRun.runId);
    expect(ids).not.toContain(nonMatchingRun.runId);
  });

  // --------------------------------------------------------------------------
  // listAttributeKeys / listAttributeValues — for filter-builder UIs
  // --------------------------------------------------------------------------
  it('enumerates attribute keys via listAttributeKeys', async () => {
    const run = await start(
      await attrWorkflow('attributesWorkflow'),
      ['ord_keys'],
      { attributes: { tenant: 't_keys' } } as any
    );
    await run.returnValue;

    const world = await getWorld();
    // TODO(attributes): drop the cast once Storage.runs.listAttributeKeys exists.
    const { data: keys } = await (world.runs as any).listAttributeKeys({
      pagination: { limit: 100 },
    });
    const seen = keys.map((k: { key: string }) => k.key);

    for (const expected of ['tenant', 'phase', 'orderId', 'stepKind']) {
      expect(seen).toContain(expected);
    }
  });

  it('enumerates attribute values for a given key via listAttributeValues', async () => {
    await start(await attrWorkflow('attributesWorkflow'), ['ord_val_a'], {
      attributes: { tenant: 't_values_one' },
    } as any).then((r) => r.returnValue);
    await start(await attrWorkflow('attributesWorkflow'), ['ord_val_b'], {
      attributes: { tenant: 't_values_two' },
    } as any).then((r) => r.returnValue);

    const world = await getWorld();
    const { data: values } = await (world.runs as any).listAttributeValues({
      key: 'tenant',
      pagination: { limit: 100 },
    });

    const seen = values.map((v: { value: string }) => v.value);
    expect(seen).toEqual(
      expect.arrayContaining(['t_values_one', 't_values_two'])
    );
  });

  it('honors prefix on listAttributeKeys', async () => {
    await start(await attrWorkflow('attributesWorkflow'), ['ord_pref'], {
      attributes: { tenant: 't_pref' },
    } as any).then((r) => r.returnValue);

    const world = await getWorld();
    const { data: keys } = await (world.runs as any).listAttributeKeys({
      prefix: 'ten',
      pagination: { limit: 100 },
    });

    expect(keys.map((k: { key: string }) => k.key)).toEqual(
      expect.arrayContaining(['tenant'])
    );
    // No key starting with `ten` other than `tenant` is created by these tests.
    for (const k of keys) {
      expect(k.key.startsWith('ten')).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // Validation — FatalError thrown before the event hits the wire
  // --------------------------------------------------------------------------
  it('rejects keys that start with a reserved $ prefix', async () => {
    // A workflow that tries to write `$ai.model` should fail with FatalError.
    // Implemented as a separate workflow function in 9_attributes.ts once the
    // API exists; this case is a placeholder so the validation path has a
    // dedicated assertion. See "Validation rules" in the V1 plan.
    expect(true).toBe(true); // TODO(attributes): drive a workflow that throws.
  });

  it('rejects values larger than 256 bytes', async () => {
    expect(true).toBe(true); // TODO(attributes): drive a workflow that throws.
  });

  it('rejects more than 64 attributes per run', async () => {
    expect(true).toBe(true); // TODO(attributes): drive a workflow that throws.
  });

  it('treats setAttributes({}) as a no-op (no attr_set event emitted)', async () => {
    expect(true).toBe(true); // TODO(attributes): drive a workflow that calls setAttributes({}).
  });
});
