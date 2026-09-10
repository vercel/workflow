import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Storage, WorkflowRun } from '@workflow/world';
import {
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
  type Streamer,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJSON } from '../fs.js';
import { createStorage } from '../storage.js';
import { createStreamer } from '../streamer.js';
import { createHook, createStep, updateStep } from '../test-helpers.js';

/**
 * `$retention: '0'` asks the World to delete a run's user data the moment the
 * run finishes. The tests below come in two halves, and the second half is
 * the one that matters: the failure mode worth guarding against is not
 * "forgot to delete", which leaves the data readable, but "deleted data
 * nobody asked to delete", which is not recoverable. So every value this
 * World does not implement — absent, `'default'`, a duration whose unit is
 * not decided yet, and outright garbage — gets its own assertion that the
 * payloads are still there afterwards.
 */
describe('run retention (world-local)', () => {
  let testDir: string;
  let storage: Storage;
  let streamer: Streamer;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-test-'));
    storage = createStorage(testDir);
    streamer = createStreamer(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const RUN_INPUT = new Uint8Array([1, 2, 3]);
  const RUN_OUTPUT = new Uint8Array([4, 5, 6]);
  const STEP_INPUT = new Uint8Array([7, 7, 7]);
  const STEP_OUTPUT = new Uint8Array([8, 8, 8]);
  const HOOK_METADATA = new Uint8Array([9, 9, 9]);

  /** A run carrying `attributes`, one completed step, and one stream. */
  async function startRun(
    attributes?: Record<string, string>
  ): Promise<WorkflowRun> {
    const created = await storage.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'retention-workflow',
        input: RUN_INPUT,
        ...(attributes ? { attributes, allowReservedAttributes: true } : {}),
      },
    });
    const run = created.run;
    if (!run) throw new Error('Expected run to be created');

    await storage.events.create(run.runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);

    await createStep(storage, run.runId, {
      stepId: 'step_001',
      stepName: 'step//./mod//doWork',
      input: STEP_INPUT,
    });
    await updateStep(storage, run.runId, 'step_001', 'step_completed', {
      result: STEP_OUTPUT,
    });

    await streamer.streams.write(run.runId, 'stream-a', 'secret payload');
    await streamer.streams.close(run.runId, 'stream-a');

    return run;
  }

  async function complete(runId: string): Promise<WorkflowRun> {
    const result = await storage.events.create(runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: RUN_OUTPUT },
    });
    if (!result.run) throw new Error('Expected run to be updated');
    return result.run;
  }

  /** Every `eventData` payload field the run's log still holds. */
  async function eventPayloads(runId: string): Promise<unknown[]> {
    const { data } = await storage.events.list({ runId, pagination: {} });
    return data.flatMap((event) => {
      const eventData = (event as { eventData?: Record<string, unknown> })
        .eventData;
      if (!eventData) return [];
      return ['input', 'output', 'result', 'error', 'metadata', 'payload']
        .filter((field) => eventData[field] !== undefined)
        .map((field) => eventData[field]);
    });
  }

  // ---------------------------------------------------------------------
  // $retention: '0' — the data goes
  // ---------------------------------------------------------------------

  describe("$retention: '0'", () => {
    it('drops the run payloads and stamps expiredAt', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      const before = Date.now();
      const completed = await complete(run.runId);

      // The write that made the run terminal is the write that purged it, so
      // the returned run is already past its boundary.
      expect(completed.expiredAt).toBeInstanceOf(Date);
      expect(completed.output).toBeUndefined();

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.input).toBeUndefined();
      expect(persisted.output).toBeUndefined();
      const expiredAt = persisted.expiredAt;
      expect(expiredAt).toBeInstanceOf(Date);
      expect(expiredAt?.getTime()).toBeGreaterThanOrEqual(before);
      expect(expiredAt?.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('keeps the run listable, with its metadata intact', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await complete(run.runId);

      const listed = await storage.runs.list({});
      const found = listed.data.find((r) => r.runId === run.runId);
      expect(found).toBeDefined();
      expect(found?.status).toBe('completed');
      expect(found?.workflowName).toBe('retention-workflow');
      // Attributes are metadata, not user payload, and the purge decision is
      // read off them — losing them would make the purge unexplainable.
      expect(found?.attributes[RETENTION_ATTRIBUTE]).toBe('0');
    });

    it('drops the step payloads but keeps the step', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await complete(run.runId);

      const steps = await storage.steps.list({ runId: run.runId });
      expect(steps.data).toHaveLength(1);
      expect(steps.data[0].stepId).toBe('step_001');
      expect(steps.data[0].status).toBe('completed');
      expect(steps.data[0].input).toBeUndefined();
      expect(steps.data[0].output).toBeUndefined();
    });

    it('drops every event payload but keeps the log', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await complete(run.runId);

      const { data } = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });
      expect(data.map((event) => event.eventType)).toEqual([
        'run_created',
        'run_started',
        'step_created',
        'step_completed',
        'run_completed',
      ]);
      expect(await eventPayloads(run.runId)).toEqual([]);
      // Non-payload eventData survives: the log still says what happened.
      const stepCreated = data.find((e) => e.eventType === 'step_created');
      expect(
        (stepCreated as { eventData: { stepName: string } }).eventData.stepName
      ).toBe('step//./mod//doWork');
    });

    it('empties the run streams and reports them finished', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await complete(run.runId);

      // Still listed — the stream exists, only its contents are gone.
      expect(await streamer.streams.list(run.runId)).toEqual(['stream-a']);

      const chunks = await streamer.streams.getChunks(run.runId, 'stream-a');
      expect(chunks.data).toEqual([]);
      expect(chunks.done).toBe(true);
      expect(chunks.hasMore).toBe(false);

      // A reader asking only for metadata must get the same answer, or a
      // tail reader would sit waiting for an EOF that never comes.
      expect(await streamer.streams.getInfo(run.runId, 'stream-a')).toEqual({
        tailIndex: -1,
        done: true,
      });
    });

    it('scrubs the metadata of a hook that outlives the run', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      // Terminal cleanup deletes a run's hooks outright, except one whose
      // token is still reserved. That one keeps its row and loses its data.
      await createHook(storage, run.runId, {
        hookId: 'hook_001',
        token: 'reserved-token',
        tokenRetentionUntil: new Date(Date.now() + 60_000),
        metadata: HOOK_METADATA,
      });

      await complete(run.runId);

      const hook = await storage.hooks.getByToken('reserved-token');
      expect(hook.hookId).toBe('hook_001');
      expect(hook.metadata).toBeUndefined();
    });

    it('purges a failed run, error included', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await storage.events.create(run.runId, {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { error: new Uint8Array([255]) },
      });

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.status).toBe('failed');
      expect(persisted.error).toBeUndefined();
      expect(persisted.expiredAt).toBeInstanceOf(Date);
      expect(await eventPayloads(run.runId)).toEqual([]);
    });

    it('purges a cancelled run', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await storage.events.create(run.runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      });

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.status).toBe('cancelled');
      expect(persisted.input).toBeUndefined();
      expect(persisted.expiredAt).toBeInstanceOf(Date);
      expect(await eventPayloads(run.runId)).toEqual([]);
    });

    it('purges a legacy run cancelled through the pre-event-sourcing path', async () => {
      // `start()` refuses to seed `$retention` below spec version 4, so this
      // is believed unreachable in practice — but the legacy shortcut writes
      // the run file itself instead of going through the lifecycle helper,
      // and the guarantee is enforced there rather than assumed.
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      await writeJSON(
        path.join(testDir, 'runs', `${run.runId}.json`),
        { ...run, status: 'running', specVersion: 1 },
        { overwrite: true }
      );

      await storage.events.create(run.runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      });

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.status).toBe('cancelled');
      expect(persisted.input).toBeUndefined();
      expect(persisted.expiredAt).toBeInstanceOf(Date);

      const steps = await storage.steps.list({ runId: run.runId });
      expect(steps.data).toHaveLength(1);
      expect(steps.data[0].output).toBeUndefined();
    });

    it('reads the freshest attributes, not the pre-validation snapshot', async () => {
      // `$retention` normally arrives with `run_created`, but an attribute
      // write can land between the terminal handler's read of the run and its
      // write. The decision is made inside the run file lock against the
      // re-read attributes for exactly that reason.
      const run = await startRun();
      await storage.runs.experimentalSetAttributes?.(
        run.runId,
        [{ key: RETENTION_ATTRIBUTE, value: '0' }],
        { allowReservedAttributes: true }
      );

      await complete(run.runId);

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.expiredAt).toBeInstanceOf(Date);
      expect(persisted.output).toBeUndefined();
      expect(await eventPayloads(run.runId)).toEqual([]);
    });

    it('leaves other runs alone', async () => {
      const keep = await startRun();
      const purge = await startRun({ [RETENTION_ATTRIBUTE]: '0' });

      await complete(purge.runId);
      await complete(keep.runId);

      const persisted = await storage.runs.get(keep.runId);
      expect(persisted.input).toEqual(RUN_INPUT);
      expect(persisted.output).toEqual(RUN_OUTPUT);
      expect(persisted.expiredAt).toBeUndefined();
      const steps = await storage.steps.list({ runId: keep.runId });
      expect(steps.data[0].output).toEqual(STEP_OUTPUT);
    });
  });

  // ---------------------------------------------------------------------
  // Everything else — the data stays
  // ---------------------------------------------------------------------

  describe('values this World does not implement', () => {
    // `'7'` is well-formed but unscalable: the unit `$retention` counts in is
    // deliberately undecided, so a World that acted on it would be guessing.
    // `'none'` and `'0.0'` are not durations at all. All of them, and an
    // absent attribute, mean the same thing here: keep the data.
    const keepers: [string, Record<string, string> | undefined][] = [
      ['absent', undefined],
      ['default', { [RETENTION_ATTRIBUTE]: 'default' }],
      ['a non-zero duration', { [RETENTION_ATTRIBUTE]: '7' }],
      ['a very large duration', { [RETENTION_ATTRIBUTE]: '999999999' }],
      ['a malformed value', { [RETENTION_ATTRIBUTE]: 'none' }],
      ['a non-integer', { [RETENTION_ATTRIBUTE]: '0.0' }],
      ['a signed zero', { [RETENTION_ATTRIBUTE]: '-0' }],
      ['a padded zero', { [RETENTION_ATTRIBUTE]: '00' }],
      ['an empty value', { [RETENTION_ATTRIBUTE]: '' }],
    ];

    for (const [label, attributes] of keepers) {
      it(`keeps everything for ${label}`, async () => {
        const run = await startRun(attributes);
        await complete(run.runId);

        const persisted = await storage.runs.get(run.runId);
        expect(persisted.expiredAt).toBeUndefined();
        expect(persisted.input).toEqual(RUN_INPUT);
        expect(persisted.output).toEqual(RUN_OUTPUT);

        const steps = await storage.steps.list({ runId: run.runId });
        expect(steps.data[0].input).toEqual(STEP_INPUT);
        expect(steps.data[0].output).toEqual(STEP_OUTPUT);

        expect(await eventPayloads(run.runId)).toEqual([
          RUN_INPUT,
          STEP_INPUT,
          STEP_OUTPUT,
          RUN_OUTPUT,
        ]);

        const chunks = await streamer.streams.getChunks(run.runId, 'stream-a');
        expect(chunks.data).toHaveLength(1);
        expect(new TextDecoder().decode(chunks.data[0].data)).toBe(
          'secret payload'
        );
      });
    }

    it('keeps the data for a run that already carries an expiredAt', async () => {
      // An `expiredAt` is a retention *deadline*, not a request to delete
      // anything now. Nothing in this World writes one except the purge, but
      // a run imported from a World that does — or a future plan-default
      // boundary — must not be mistaken for a zero-retention run.
      const run = await startRun();
      const deadline = new Date(Date.now() + 86_400_000);
      const stored = await storage.runs.get(run.runId);
      await writeJSON(
        path.join(testDir, 'runs', `${run.runId}.json`),
        { ...stored, expiredAt: deadline },
        { overwrite: true }
      );

      await complete(run.runId);

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.expiredAt).toEqual(deadline);
      expect(persisted.input).toEqual(RUN_INPUT);
      expect(persisted.output).toEqual(RUN_OUTPUT);
      const steps = await storage.steps.list({ runId: run.runId });
      expect(steps.data[0].output).toEqual(STEP_OUTPUT);
    });

    it('keeps the data for an unrelated reserved attribute', async () => {
      const run = await startRun({ $someOtherThing: '0' });
      await complete(run.runId);

      const persisted = await storage.runs.get(run.runId);
      expect(persisted.expiredAt).toBeUndefined();
      expect(persisted.output).toEqual(RUN_OUTPUT);
    });

    it('does not purge before the run is terminal', async () => {
      const run = await startRun({ [RETENTION_ATTRIBUTE]: '0' });

      const running = await storage.runs.get(run.runId);
      expect(running.status).toBe('running');
      expect(running.expiredAt).toBeUndefined();
      expect(running.input).toEqual(RUN_INPUT);

      const steps = await storage.steps.list({ runId: run.runId });
      expect(steps.data[0].output).toEqual(STEP_OUTPUT);
    });
  });
});
