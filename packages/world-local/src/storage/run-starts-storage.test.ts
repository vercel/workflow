import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunStartsStorage } from './run-starts-storage.js';

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

  it('adopts one durable reservation across independently created storage instances', async () => {
    const first = createRunStartsStorage(basedir);
    const second = createRunStartsStorage(basedir);

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
    const starts = createRunStartsStorage(basedir);
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
    const first = createRunStartsStorage(basedir);
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
    const adopted =
      await createRunStartsStorage(basedir).finalizeOrAdoptRunStart(finalize);

    expect(winner.messageId).toMatch(/^msg_/);
    expect(adopted).toEqual({ ...winner, inserted: false });
  });

  it('rejects a divergent finalization without replacing the winner', async () => {
    const starts = createRunStartsStorage(basedir);
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
    const starts = createRunStartsStorage(basedir);
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

    const recovered = createRunStartsStorage(basedir);
    expect(await recovered.pendingDispatches()).toEqual([
      expect.objectContaining({
        runId: reservation.runId,
        messageId: receipt.messageId,
      }),
    ]);
    await recovered.acknowledgeDispatch(receipt.messageId);
    expect(await createRunStartsStorage(basedir).pendingDispatches()).toEqual(
      []
    );
  });

  it('projects and drains one canonical finalized start, then acknowledges only after acceptance', async () => {
    const materialize = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockImplementation(async (_entry, accepted) => {
      await accepted();
    });
    const starts = createRunStartsStorage(basedir, { materialize, dispatch });
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
      expect.any(Function)
    );
    expect(await starts.pendingDispatches()).toEqual([]);
  });

  it('fails closed on a corrupt durable reservation', async () => {
    const starts = createRunStartsStorage(basedir);
    await starts.reserveOrAdoptRunStart(request());
    const [name] = await fs.readdir(path.join(basedir, 'run-starts'));
    await fs.writeFile(
      path.join(basedir, 'run-starts', name),
      JSON.stringify({ version: 1, runId: 42 })
    );

    await expect(
      createRunStartsStorage(basedir).reserveOrAdoptRunStart(request())
    ).rejects.toThrow('corrupt run-start ledger');
  });
});
