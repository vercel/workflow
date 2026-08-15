import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from '../index.js';
import { createEventsStorage } from './events-storage.js';
import { createRunStartsStorage } from './run-starts-storage.js';

const childDir = process.env.WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_DIR;
const childMarker =
  process.env.WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_MARKER;
const childStage = process.env.WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_STAGE;

if (childDir && childMarker && childStage) {
  describe('run-start projection child interruption', () => {
    it(`stops at ${childStage}`, async () => {
      async function checkpoint(
        stage: 'after-run' | 'after-event' | 'before-dispatch'
      ) {
        if (stage !== childStage) return;
        await fs.writeFile(childMarker, stage);
        await new Promise<never>(() => {});
      }
      const events = createEventsStorage(childDir, undefined, async (stage) => {
        await checkpoint(stage);
      });
      const starts = createRunStartsStorage(childDir, {
        prepareProjection: (entry) =>
          events.prepareRunCreatedProjection({
            runId: entry.runId,
            envelope: entry.envelope,
          }),
        materialize: (entry) =>
          events.materializeOrAdoptRunCreatedProjection(entry.projection),
        dispatch: async (_entry, accepted) => {
          await checkpoint('before-dispatch');
          await accepted();
        },
      });
      const reservation = await starts.reserveOrAdoptRunStart({
        idempotencyKey: 'eve:child:process',
        startShapeDigest: 'shape',
        workflowName: 'child',
        deploymentId: 'dpl_local',
        specVersion: 5,
      });
      await starts.finalizeOrAdoptRunStart({
        reservationId: reservation.reservationId,
        runId: reservation.runId,
        semanticDigest: 'semantic',
        envelopeIntegrityDigest: 'envelope',
        envelope: {
          runCreated: {
            eventType: 'run_created',
            specVersion: 5,
            eventData: {
              deploymentId: 'dpl_local',
              workflowName: 'child',
              input: { type: 'json', value: 'input' },
              executionContext: {},
            },
          },
        },
        queueName: '__wkf_workflow_child',
        queuePayload: { runId: reservation.runId },
        queueOptions: {},
      });
      await starts.drain();
    });
  });
}

describe('world-local run-start projection', () => {
  let basedir: string;

  beforeEach(async () => {
    basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-start-projection-'));
  });

  afterEach(async () => {
    await fs.rm(basedir, { recursive: true, force: true });
  });

  it('advertises only the proven local idempotent run-start capability', () => {
    const world = createWorld({ dataDir: basedir });

    expect(world.capabilities).toMatchObject({ idempotentRunStartVersion: 1 });
    expect(world.capabilities).not.toHaveProperty('keyedStreamAppendVersion');
  });

  async function finalized() {
    const events = createEventsStorage(basedir);
    const dispatch = vi.fn(async (_entry, accepted) => accepted());
    const starts = createRunStartsStorage(basedir, {
      prepareProjection: (entry) =>
        events.prepareRunCreatedProjection({
          runId: entry.runId,
          envelope: entry.envelope,
        }),
      materialize: (entry) =>
        events.materializeOrAdoptRunCreatedProjection(entry.projection),
      dispatch,
    });
    const reservation = await starts.reserveOrAdoptRunStart({
      idempotencyKey: 'eve:child:projection',
      startShapeDigest: 'shape',
      workflowName: 'child',
      deploymentId: 'dpl_local',
      specVersion: 5,
    });
    await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic',
      envelopeIntegrityDigest: 'envelope',
      envelope: {
        runCreated: {
          eventType: 'run_created',
          specVersion: 5,
          eventData: {
            deploymentId: 'dpl_local',
            workflowName: 'child',
            input: { type: 'json', value: 'input' },
            executionContext: {},
          },
        },
      },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });
    const [entry] = await starts.pendingDispatches();
    return { events, starts, dispatch, entry };
  }

  it('repairs a durable run-only interruption with the fixed run_created bytes before dispatch', async () => {
    const { starts, dispatch, entry } = await finalized();
    await fs.mkdir(path.join(basedir, 'runs'), { recursive: true });
    await fs.writeFile(
      path.join(basedir, 'runs', `${entry.runId}.json`),
      entry.projection.runBytes
    );

    await starts.drain();

    expect(
      await fs.readFile(
        path.join(
          basedir,
          'events',
          `${entry.runId}-${entry.projection.eventId}.json`
        ),
        'utf8'
      )
    ).toBe(entry.projection.eventBytes);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await starts.pendingDispatches()).toEqual([]);
  });

  it('fails closed rather than dispatching when a surviving run differs from the ledger', async () => {
    const { starts, dispatch, entry } = await finalized();
    await fs.mkdir(path.join(basedir, 'runs'), { recursive: true });
    await fs.writeFile(
      path.join(basedir, 'runs', `${entry.runId}.json`),
      '{"different":true}'
    );

    await expect(starts.drain()).rejects.toThrow('idempotency_conflict');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed on a reader-visible event without its canonical run', async () => {
    const { starts, dispatch, entry } = await finalized();
    await fs.mkdir(path.join(basedir, 'events'), { recursive: true });
    await fs.writeFile(
      path.join(
        basedir,
        'events',
        `${entry.runId}-${entry.projection.eventId}.json`
      ),
      entry.projection.eventBytes
    );

    await expect(starts.drain()).rejects.toThrow('event without run');
    expect(dispatch).not.toHaveBeenCalled();
  });

  async function recoverChildInterruption(
    stage: 'after-run' | 'after-event' | 'before-dispatch'
  ) {
    const marker = path.join(basedir, `checkpoint-${stage}`);
    const child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'packages/world-local/src/storage/run-start-projection.test.ts',
        '--testNamePattern',
        `stops at ${stage}`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_DIR: basedir,
          WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_MARKER: marker,
          WORKFLOW_LOCAL_RUN_START_PROJECTION_CHILD_STAGE: stage,
        },
        stdio: 'ignore',
      }
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        await fs
          .stat(marker)
          .then(() => true)
          .catch(() => false)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await fs
        .stat(marker)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const events = createEventsStorage(basedir);
    const dispatch = vi.fn(async (_entry, accepted) => accepted());
    const starts = createRunStartsStorage(basedir, {
      prepareProjection: (entry) =>
        events.prepareRunCreatedProjection({
          runId: entry.runId,
          envelope: entry.envelope,
        }),
      materialize: (entry) =>
        events.materializeOrAdoptRunCreatedProjection(entry.projection),
      dispatch,
    });
    const reservation = await starts.reserveOrAdoptRunStart({
      idempotencyKey: 'eve:child:process',
      startShapeDigest: 'shape',
      workflowName: 'child',
      deploymentId: 'dpl_local',
      specVersion: 5,
    });
    await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic',
      envelopeIntegrityDigest: 'envelope',
      envelope: {
        runCreated: {
          eventType: 'run_created',
          specVersion: 5,
          eventData: {
            deploymentId: 'dpl_local',
            workflowName: 'child',
            input: { type: 'json', value: 'input' },
            executionContext: {},
          },
        },
      },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });
    const [pending] = await starts.pendingDispatches();
    await starts.drain();
    const listed = await events.list({
      runId: reservation.runId,
      pagination: { limit: 10 },
    });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      eventType: 'run_created',
      runId: reservation.runId,
      eventId: pending.projection.eventId,
    });
    expect(
      await fs.readFile(
        path.join(basedir, 'runs', `${reservation.runId}.json`),
        'utf8'
      )
    ).toBe(pending.projection.runBytes);
    expect(
      await fs.readFile(
        path.join(
          basedir,
          'events',
          `${reservation.runId}-${pending.projection.eventId}.json`
        ),
        'utf8'
      )
    ).toBe(pending.projection.eventBytes);
    const [ledgerName] = await fs.readdir(path.join(basedir, 'run-starts'));
    const ledger = JSON.parse(
      await fs.readFile(path.join(basedir, 'run-starts', ledgerName), 'utf8')
    );
    expect(ledger.finalization.projection).toMatchObject({
      digest: pending.projection.digest,
      eventId: pending.projection.eventId,
      state: 'complete',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: pending.messageId,
        queueName: pending.queueName,
        queuePayload: pending.queuePayload,
      }),
      expect.any(Function),
      expect.stringMatching(/^dsp_/)
    );
    expect(await starts.pendingDispatches()).toEqual([]);
  }

  it('repairs a real child-process interruption after the run write without changing the canonical projection', async () => {
    await recoverChildInterruption('after-run');
  });

  it('repairs a real child-process interruption after the canonical event write before projection completion', async () => {
    await recoverChildInterruption('after-event');
  });

  it('dispatches the stable outbox message once after a real child-process interruption after projection completion', async () => {
    await recoverChildInterruption('before-dispatch');
  });
});
