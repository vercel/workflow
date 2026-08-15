import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunStartsStorage } from './run-starts-storage.js';

const receiverChildDir = process.env.WORKFLOW_LOCAL_RUN_START_RECEIVER_DIR;
const receiverChildMessageId = process.env.WORKFLOW_LOCAL_RUN_START_MESSAGE_ID;
const receiverChildOwner = process.env.WORKFLOW_LOCAL_RUN_START_OWNER;
const receiverChildMarker = process.env.WORKFLOW_LOCAL_RUN_START_MARKER;

if (
  receiverChildDir &&
  receiverChildMessageId &&
  receiverChildOwner &&
  receiverChildMarker
) {
  describe('run-start receiver child', () => {
    it('enters a durable receiver attempt and waits for termination', async () => {
      const starts = createRunStartsStorage(receiverChildDir);
      const attempt = await starts.receiverStarted(
        receiverChildMessageId,
        receiverChildOwner,
        process.pid
      );
      await fs.writeFile(
        receiverChildMarker,
        JSON.stringify({ attempt, pid: process.pid })
      );
      await new Promise<void>(() => {});
    });
  });
}

describe('world-local idempotent run-start ledger', () => {
  let basedir: string;

  beforeEach(async () => {
    basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-starts-'));
  });

  afterEach(async () => {
    await fs.rm(basedir, { recursive: true, force: true });
  });

  const request = (overrides = {}) => ({
    idempotencyKey: 'eve:child:1',
    startShapeDigest: 'shape-a',
    workflowName: 'child',
    deploymentId: 'dpl_local',
    specVersion: 5,
    ...overrides,
  });

  const drivers = {
    prepareProjection: async (entry: { runId: string }) => ({
      version: 1 as const,
      runBytes: JSON.stringify({ runId: entry.runId }),
      eventBytes: JSON.stringify({
        eventType: 'run_created',
        runId: entry.runId,
      }),
      eventId: 'evnt_00000000000000000000000001',
      digest: 'projection-a',
    }),
    materialize: async () => {},
    dispatch: async (_entry: unknown, accepted: () => Promise<void>) =>
      accepted(),
  };

  async function waitForFile(file: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fs
          .access(file)
          .then(() => true)
          .catch(() => false)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${file}`);
  }

  function startReceiverProcess(
    messageId: string,
    owner: string,
    marker: string
  ) {
    return spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'packages/world-local/src/storage/run-starts-storage.test.ts',
        '--testNamePattern',
        'enters a durable receiver attempt',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_LOCAL_RUN_START_RECEIVER_DIR: basedir,
          WORKFLOW_LOCAL_RUN_START_MESSAGE_ID: messageId,
          WORKFLOW_LOCAL_RUN_START_OWNER: owner,
          WORKFLOW_LOCAL_RUN_START_MARKER: marker,
        },
        stdio: 'ignore',
      }
    );
  }

  it('adopts one durable reservation across independently created storage instances', async () => {
    const first = createRunStartsStorage(basedir, drivers);
    const second = createRunStartsStorage(basedir, drivers);

    const [a, b] = await Promise.all([
      first.reserveOrAdoptRunStart(request()),
      second.reserveOrAdoptRunStart(request()),
    ]);

    expect(a.runId).toMatch(/^wrun_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b.runId).toBe(a.runId);
    expect(b.reservationId).toBe(a.reservationId);
    expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
  });

  it('rejects divergent reservation input without allocating another run', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const first = await starts.reserveOrAdoptRunStart(request());

    await expect(
      starts.reserveOrAdoptRunStart(request({ workflowName: 'other' }))
    ).rejects.toThrow('idempotency_conflict');

    expect(await starts.reserveOrAdoptRunStart(request())).toEqual({
      ...first,
      inserted: false,
    });
  });

  it('finalizes once and adopts the original stable dispatch receipt', async () => {
    const first = createRunStartsStorage(basedir, drivers);
    const reservation = await first.reserveOrAdoptRunStart(request());
    const finalize = {
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: { deploymentId: 'dpl_local' },
    };

    const winner = await first.finalizeOrAdoptRunStart(finalize);
    const adopted = await createRunStartsStorage(
      basedir,
      drivers
    ).finalizeOrAdoptRunStart(finalize);

    expect(winner.messageId).toMatch(/^msg_/);
    expect(adopted).toEqual({ ...winner, inserted: false });
  });

  it('rejects a divergent finalization without replacing the winner', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const base = {
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    };
    const winner = await starts.finalizeOrAdoptRunStart(base);

    await expect(
      starts.finalizeOrAdoptRunStart({ ...base, semanticDigest: 'semantic-b' })
    ).rejects.toThrow('idempotency_conflict');
    expect(await starts.finalizeOrAdoptRunStart(base)).toEqual({
      ...winner,
      inserted: false,
    });
  });

  it('keeps a stable pending outbox message through restart until acknowledged', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    const recovered = createRunStartsStorage(basedir, drivers);
    expect(await recovered.pendingDispatches()).toEqual([
      expect.objectContaining({
        runId: reservation.runId,
        messageId: receipt.messageId,
      }),
    ]);
    await recovered.drain();
    expect(
      await createRunStartsStorage(basedir, drivers).pendingDispatches()
    ).toEqual([]);
  });

  it('projects and drains one canonical finalized start, then acknowledges only after acceptance', async () => {
    const materialize = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockImplementation(async (_entry, accepted) => {
      await accepted();
    });
    const starts = createRunStartsStorage(basedir, {
      ...drivers,
      materialize,
      dispatch,
    });
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    await starts.drain();

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: receipt.messageId }),
      expect.any(Function),
      expect.stringMatching(/^dsp_/)
    );
    expect(await starts.pendingDispatches()).toEqual([]);
  });

  it('atomically leases one pending outbox record to one concurrent drainer', async () => {
    let accept!: () => Promise<void>;
    let active = 0;
    let peak = 0;
    const dispatch = vi.fn(async (_entry, accepted) => {
      active++;
      peak = Math.max(peak, active);
      accept = async () => {
        active--;
        await accepted();
      };
      await new Promise<void>((resolve) => {
        const previous = accept;
        accept = async () => {
          await previous();
          resolve();
        };
      });
    });
    const first = createRunStartsStorage(basedir, { ...drivers, dispatch });
    const reservation = await first.reserveOrAdoptRunStart(request());
    const receipt = await first.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    const draining = first.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const competing = createRunStartsStorage(basedir, {
      ...drivers,
      dispatch,
    }).drain();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    await accept();
    await Promise.all([draining, competing]);
    expect(await first.pendingDispatches()).toEqual([]);
    expect(receipt.messageId).toMatch(/^msg_/);
  });

  it('keeps peak receiver entry at one across sender transport loss and receiver-process recovery', async () => {
    let receiver: ReturnType<typeof startReceiverProcess> | undefined;
    const sent: Array<{ messageId: string; bytes: string }> = [];
    const first = createRunStartsStorage(basedir, {
      ...drivers,
      dispatch: async (entry, _accepted, owner) => {
        sent.push({
          messageId: entry.messageId,
          bytes: JSON.stringify(entry.queuePayload),
        });
        const marker = path.join(basedir, 'receiver-entered.json');
        receiver = startReceiverProcess(entry.messageId, owner, marker);
        await waitForFile(marker);
        throw new Error(
          'simulated sender transport abort after receiver entry'
        );
      },
    });
    const reservation = await first.reserveOrAdoptRunStart(request());
    const receipt = await first.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId, stable: 'bytes' },
      queueOptions: {},
    });
    try {
      await expect(first.drain()).rejects.toThrow('sender transport abort');
      const blockedDispatch = vi.fn();
      await createRunStartsStorage(basedir, {
        ...drivers,
        dispatch: blockedDispatch,
      }).drain();
      expect(blockedDispatch).not.toHaveBeenCalled();
      expect(sent).toEqual([
        {
          messageId: receipt.messageId,
          bytes: JSON.stringify({ runId: reservation.runId, stable: 'bytes' }),
        },
      ]);

      receiver.kill();
      await new Promise<void>((resolve) =>
        receiver!.once('exit', () => resolve())
      );

      const recovered: Array<{ messageId: string; bytes: string }> = [];
      await createRunStartsStorage(basedir, {
        ...drivers,
        dispatch: async (entry, accepted) => {
          recovered.push({
            messageId: entry.messageId,
            bytes: JSON.stringify(entry.queuePayload),
          });
          await accepted();
        },
      }).drain();
      expect(recovered).toEqual(sent);
      expect(await first.pendingDispatches()).toEqual([]);
    } finally {
      receiver?.kill();
    }
  }, 30_000);

  it('does not reclaim a dead sender while its receiver attempt is active', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    const receiverAttempt = await starts.receiverStarted(
      receipt.messageId,
      'dsp_test',
      process.pid
    );
    await expect(
      starts.returnDispatch(receipt.messageId, 'dsp_test')
    ).resolves.toBeUndefined();
    expect(await starts.pendingDispatches()).toHaveLength(1);
    await starts.receiverTerminated(
      receipt.messageId,
      'dsp_test',
      process.pid,
      receiverAttempt
    );
  });

  it('rejects a second receiver entry even when it reuses the dispatch owner', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    await starts.receiverStarted(receipt.messageId, 'dsp_test', process.pid);

    await expect(
      starts.receiverStarted(receipt.messageId, 'dsp_test', process.pid)
    ).rejects.toThrow('active run-start receiver');
  });

  it('does not let a stale receiver termination clear the adopted attempt', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });
    const attempt = await starts.receiverStarted(
      receipt.messageId,
      'dsp_test',
      process.pid
    );

    await starts.receiverTerminated(
      receipt.messageId,
      'dsp_test',
      process.pid,
      'rcv_stale'
    );
    await expect(
      starts.receiverStarted(receipt.messageId, 'dsp_test', process.pid)
    ).rejects.toThrow('active run-start receiver');

    await starts.receiverTerminated(
      receipt.messageId,
      'dsp_test',
      process.pid,
      attempt
    );
    await expect(
      starts.receiverStarted(receipt.messageId, 'dsp_test', process.pid)
    ).resolves.toMatch(/^rcv_/);
  });

  it('refuses a live receiver after a stale sender lock is acquired', async () => {
    const dispatch = vi.fn(async (_entry, accepted) => accepted());
    const starts = createRunStartsStorage(basedir, { ...drivers, dispatch });
    const reservation = await starts.reserveOrAdoptRunStart(request());
    const receipt = await starts.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId },
      queueOptions: {},
    });

    await starts.receiverStarted(receipt.messageId, 'dsp_stale', process.pid);
    await createRunStartsStorage(basedir, { ...drivers, dispatch }).drain();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed on a corrupt durable reservation', async () => {
    const starts = createRunStartsStorage(basedir, drivers);
    await starts.reserveOrAdoptRunStart(request());
    const [name] = await fs.readdir(path.join(basedir, 'run-starts'));
    await fs.writeFile(
      path.join(basedir, 'run-starts', name),
      JSON.stringify({ version: 1, runId: 42 })
    );

    await expect(
      createRunStartsStorage(basedir, drivers).reserveOrAdoptRunStart(request())
    ).rejects.toThrow('corrupt run-start ledger');
  });
});
