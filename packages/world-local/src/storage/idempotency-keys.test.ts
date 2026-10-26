/**
 * Run idempotency keys on the Local World: the shared conformance suite, plus
 * the filesystem specifics it cannot see (claim file layout, cleanup when the
 * run write fails, the key surviving status transitions, two storage
 * instances over one data directory).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EntityConflictError,
  WorkflowRunAlreadyStartedError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  type EventResult,
  IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
  type IdempotencyKeyReusePolicy,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIdempotencyConformance } from '../../../world/src/test-support/run-idempotency-conformance.js';
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';
import {
  createRunClaimingIdempotencyKey,
  IdempotencyKeyClaimSchema,
  idempotencyKeyClaimPath,
} from './idempotency-keys.js';

const SPEC = SPEC_VERSION_CURRENT;

/** `create` without its overloads, so a test can pass any request. */
function createEvent(
  events: Storage['events'],
  runId: string,
  data: AnyEventRequest
): Promise<EventResult> {
  return (
    events.create as (
      runId: string,
      data: AnyEventRequest
    ) => Promise<EventResult>
  )(runId, data);
}
const ulid = monotonicFactory();
const newRunId = () => `wrun_${ulid()}`;

// The conformance suite shares one data directory across its tests (each
// test uses its own keys), so `events` and `runs` see the same data.
const conformanceDir = mkdtempSync(path.join(os.tmpdir(), 'wl-idem-conf-'));
const conformanceStorage = createStorage(conformanceDir);
afterAll(() => {
  rmSync(conformanceDir, { recursive: true, force: true });
});

runIdempotencyConformance({
  name: 'world-local',
  events: () => conformanceStorage.events,
  runs: () => conformanceStorage.runs,
  capabilities: () => createWorld({ dataDir: conformanceDir }).capabilities,
  newRunId,
  // Deleting the run file is how the holder stops existing here.
  deleteRun: async (runId) => {
    await fs.rm(path.join(conformanceDir, 'runs', `${runId}.json`));
  },
});

describe('run idempotency keys (world-local)', () => {
  let dir: string;
  let storage: ReturnType<typeof createStorage>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-idem-'));
    storage = createStorage(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const workflowName = 'workflow//./src/orders//process';

  function runCreated(
    key: string,
    policy: IdempotencyKeyReusePolicy = 'REJECT_DUPLICATE'
  ): AnyEventRequest {
    return {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_idem',
        workflowName,
        input: new Uint8Array([1]),
        idempotencyKey: key,
        idempotencyKeyTtlMs: 3_600_000,
        idempotencyKeyReusePolicy: policy,
      },
    } as AnyEventRequest;
  }

  async function readClaim(key: string) {
    const raw = await fs.readFile(
      idempotencyKeyClaimPath(dir, workflowName, key),
      'utf8'
    );
    return IdempotencyKeyClaimSchema.parse(JSON.parse(raw));
  }

  async function complete(events: typeof storage.events, runId: string) {
    await createEvent(events, runId, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as AnyEventRequest);
    await createEvent(events, runId, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([2]) },
    } as AnyEventRequest);
  }

  it('records the claim in a file named by the hashed (workflowName, key)', async () => {
    const runId = newRunId();
    await createEvent(storage.events, runId, runCreated('order-1'));

    const claimPath = idempotencyKeyClaimPath(dir, workflowName, 'order-1');
    expect(path.relative(dir, claimPath)).toMatch(
      /^idempotency-keys[/\\][0-9a-f]{64}\.json$/
    );
    expect(await readClaim('order-1')).toMatchObject({
      runId,
      workflowName,
      key: 'order-1',
      ttlMs: 3_600_000,
    });
    // The same key under another workflow is a different file.
    expect(
      idempotencyKeyClaimPath(dir, `${workflowName}_2`, 'order-1')
    ).not.toBe(claimPath);
  });

  it('keeps the key on the run through every status transition', async () => {
    const runId = newRunId();
    await createEvent(storage.events, runId, runCreated('order-1'));
    await complete(storage.events, runId);

    const run = await storage.runs.get(runId);
    expect(run.status).toBe('completed');
    expect(run.idempotencyKey).toBe('order-1');
  });

  it('moves the claim to the new run on a takeover', async () => {
    const first = newRunId();
    await createEvent(storage.events, first, runCreated('order-1'));
    await complete(storage.events, first);

    const second = newRunId();
    await createEvent(
      storage.events,
      second,
      runCreated('order-1', 'ALLOW_DUPLICATE')
    );

    expect((await readClaim('order-1')).runId).toBe(second);
    // Settled once the new run exists: nothing left to fall back to.
    expect((await readClaim('order-1')).previous).toBeUndefined();
    // The old holder keeps its own record of the key it started with.
    expect((await storage.runs.get(first)).idempotencyKey).toBe('order-1');
  });

  it('removes a fresh claim when the run cannot be written', async () => {
    const runId = newRunId();
    await expect(
      createRunClaimingIdempotencyKey({
        basedir: dir,
        tag: undefined,
        runId,
        workflowName,
        key: 'order-1',
        ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        reusePolicy: 'REJECT_DUPLICATE',
        writeRun: async () => {
          throw new Error('disk full');
        },
      })
    ).rejects.toThrow('disk full');

    await expect(
      fs.access(idempotencyKeyClaimPath(dir, workflowName, 'order-1'))
    ).rejects.toThrow();
    // The key is free for the next start.
    await expect(
      createEvent(storage.events, newRunId(), runCreated('order-1'))
    ).resolves.toBeDefined();
  });

  it('puts the previous holder back when a takeover cannot write its run', async () => {
    const holder = newRunId();
    await createEvent(storage.events, holder, runCreated('order-1'));
    await complete(storage.events, holder);

    await expect(
      createRunClaimingIdempotencyKey({
        basedir: dir,
        tag: undefined,
        runId: newRunId(),
        workflowName,
        key: 'order-1',
        ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        reusePolicy: 'ALLOW_DUPLICATE',
        writeRun: async () => false,
      })
    ).rejects.toSatisfy(EntityConflictError.is);

    expect(await readClaim('order-1')).toMatchObject({
      runId: holder,
      ttlMs: 3_600_000,
    });
  });

  /**
   * The on-disk state a claimer leaves when its process dies after writing
   * its claim and before writing its run: the claim it wrote, with no run
   * and no rollback. Captured from inside `writeRun`, then put back after
   * the call's own rollback, which a dead process never runs.
   */
  async function dieBetweenClaimAndRun(
    runId: string,
    key: string,
    reusePolicy: IdempotencyKeyReusePolicy
  ) {
    const claimPath = idempotencyKeyClaimPath(dir, workflowName, key);
    let snapshot = '';
    await createRunClaimingIdempotencyKey({
      basedir: dir,
      tag: undefined,
      runId,
      workflowName,
      key,
      ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
      reusePolicy,
      writeRun: async () => {
        snapshot = await fs.readFile(claimPath, 'utf8');
        throw new Error('process died');
      },
    }).catch(() => {});
    await fs.writeFile(claimPath, snapshot);
    return IdempotencyKeyClaimSchema.parse(JSON.parse(snapshot));
  }

  describe('a claimer that dies between its claim and its run', () => {
    it('keeps the key with the holder its claim replaced', async () => {
      const holder = newRunId();
      await createEvent(storage.events, holder, runCreated('order-1'));
      await complete(storage.events, holder);

      const ghost = newRunId();
      const left = await dieBetweenClaimAndRun(
        ghost,
        'order-1',
        'ALLOW_DUPLICATE'
      );
      expect(left).toMatchObject({
        runId: ghost,
        previous: { runId: holder, ttlMs: 3_600_000 },
      });
      await expect(storage.runs.get(ghost)).rejects.toThrow();

      // Without `previous` this start would find no holder and take the key.
      const error = await createEvent(
        storage.events,
        newRunId(),
        runCreated('order-1')
      ).catch((err: unknown) => err);
      expect(WorkflowRunAlreadyStartedError.is(error)).toBe(true);
      expect(error).toMatchObject({ runId: holder, runStatus: 'completed' });
      expect((await readClaim('order-1')).runId).toBe(ghost);
    });

    it('lets a start the old holder would allow take the key, and settles the claim', async () => {
      const holder = newRunId();
      await createEvent(storage.events, holder, runCreated('order-1'));
      await complete(storage.events, holder);
      await dieBetweenClaimAndRun(newRunId(), 'order-1', 'ALLOW_DUPLICATE');

      const next = newRunId();
      await createEvent(
        storage.events,
        next,
        runCreated('order-1', 'ALLOW_DUPLICATE')
      );

      const claim = await readClaim('order-1');
      expect(claim.runId).toBe(next);
      expect(claim.previous).toBeUndefined();
    });

    it('lets a retry of the dead start, with the same run id, finish its takeover', async () => {
      const holder = newRunId();
      await createEvent(storage.events, holder, runCreated('order-1'));
      await complete(storage.events, holder);
      const ghost = newRunId();
      await dieBetweenClaimAndRun(ghost, 'order-1', 'ALLOW_DUPLICATE');

      await createEvent(
        storage.events,
        ghost,
        runCreated('order-1', 'ALLOW_DUPLICATE')
      );
      expect((await storage.runs.get(ghost)).status).toBe('pending');
      expect(await readClaim('order-1')).toMatchObject({ runId: ghost });
      expect((await readClaim('order-1')).previous).toBeUndefined();
    });

    it('refuses the same-run-id retry when its policy does not allow taking from the holder', async () => {
      const holder = newRunId();
      await createEvent(storage.events, holder, runCreated('order-1'));
      await complete(storage.events, holder);
      const ghost = newRunId();
      await dieBetweenClaimAndRun(ghost, 'order-1', 'ALLOW_DUPLICATE');

      await expect(
        createEvent(storage.events, ghost, runCreated('order-1'))
      ).rejects.toSatisfy(WorkflowRunAlreadyStartedError.is);
    });

    it('frees the key when the dead claimer had replaced no holder', async () => {
      const left = await dieBetweenClaimAndRun(
        newRunId(),
        'order-1',
        'REJECT_DUPLICATE'
      );
      expect(left.previous).toBeUndefined();

      const next = newRunId();
      await createEvent(storage.events, next, runCreated('order-1'));
      expect((await readClaim('order-1')).runId).toBe(next);
    });

    it('frees the key when the replaced holder no longer exists either', async () => {
      const holder = newRunId();
      await createEvent(storage.events, holder, runCreated('order-1'));
      await complete(storage.events, holder);
      await dieBetweenClaimAndRun(newRunId(), 'order-1', 'ALLOW_DUPLICATE');
      await fs.rm(path.join(dir, 'runs', `${holder}.json`));

      const next = newRunId();
      await createEvent(storage.events, next, runCreated('order-1'));
      expect((await readClaim('order-1')).runId).toBe(next);
    });
  });

  it('does not roll back a claim that no longer names the failed run', async () => {
    const claimPath = idempotencyKeyClaimPath(dir, workflowName, 'order-1');
    const other = newRunId();
    await expect(
      createRunClaimingIdempotencyKey({
        basedir: dir,
        tag: undefined,
        runId: newRunId(),
        workflowName,
        key: 'order-1',
        ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        reusePolicy: 'REJECT_DUPLICATE',
        writeRun: async () => {
          // Another claimer's write (e.g. after this one's lock went stale).
          await fs.writeFile(
            claimPath,
            JSON.stringify({
              runId: other,
              workflowName,
              key: 'order-1',
              ttlMs: 1000,
              createdAt: new Date().toISOString(),
            })
          );
          throw new Error('disk full');
        },
      })
    ).rejects.toThrow('disk full');

    expect((await readClaim('order-1')).runId).toBe(other);
  });

  it('rethrows the run write error when the rollback itself fails', async () => {
    const claimPath = idempotencyKeyClaimPath(dir, workflowName, 'order-1');
    await expect(
      createRunClaimingIdempotencyKey({
        basedir: dir,
        tag: undefined,
        runId: newRunId(),
        workflowName,
        key: 'order-1',
        ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        reusePolicy: 'REJECT_DUPLICATE',
        writeRun: async () => {
          // A directory where the claim was: reading it back fails.
          await fs.rm(claimPath);
          await fs.mkdir(claimPath);
          throw new Error('disk full');
        },
      })
    ).rejects.toThrow('disk full');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'removes the run and the claim when run_created cannot be journaled',
    async () => {
      const runId = newRunId();
      // The run's event directory exists but is read-only, so the run file
      // is written and then its creation event fails.
      const eventsDir = path.join(dir, 'events', runId);
      await fs.mkdir(eventsDir, { recursive: true });
      await fs.chmod(eventsDir, 0o555);
      try {
        await expect(
          createEvent(storage.events, runId, runCreated('order-1'))
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await fs.chmod(eventsDir, 0o755);
      }

      await expect(
        fs.access(path.join(dir, 'runs', `${runId}.json`))
      ).rejects.toThrow();
      await expect(
        fs.access(idempotencyKeyClaimPath(dir, workflowName, 'order-1'))
      ).rejects.toThrow();
      // Nothing holds the key, and the same start succeeds once it can.
      const result = await createEvent(
        storage.events,
        runId,
        runCreated('order-1')
      );
      expect(result.run?.runId).toBe(runId);
      const events = await storage.events.list({ runId });
      expect(events.data.map((event) => event.eventType)).toEqual([
        'run_created',
      ]);
    }
  );

  it('journals run_created exactly once for a keyed run', async () => {
    const runId = newRunId();
    await createEvent(storage.events, runId, runCreated('order-1'));
    await complete(storage.events, runId);
    const events = await storage.events.list({ runId });
    expect(events.data.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'run_completed',
    ]);
  });

  it('refuses with the holder, and writes neither a run nor a claim', async () => {
    const holder = newRunId();
    await createEvent(storage.events, holder, runCreated('order-1'));

    const refused = newRunId();
    const error = await createEvent(
      storage.events,
      refused,
      runCreated('order-1', 'ALLOW_DUPLICATE')
    ).catch((err: unknown) => err);

    expect(WorkflowRunAlreadyStartedError.is(error)).toBe(true);
    expect(error).toMatchObject({
      runId: holder,
      runStatus: 'pending',
      workflowName,
      idempotencyKey: 'order-1',
    });
    await expect(storage.runs.get(refused)).rejects.toThrow();
    expect((await storage.events.list({ runId: refused })).data).toHaveLength(
      0
    );
    expect((await readClaim('order-1')).runId).toBe(holder);
  });

  it('lets exactly one of two storage instances on one directory claim a key', async () => {
    const other = createStorage(dir);
    const outcomes = await Promise.allSettled(
      [storage, other, storage, other].map((s) =>
        createEvent(s.events, newRunId(), runCreated('order-1'))
      )
    );
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const winner = (
      winners[0] as PromiseFulfilledResult<{
        run?: { runId: string };
      }>
    ).value.run?.runId;
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        expect(o.reason).toMatchObject({
          name: 'WorkflowRunAlreadyStartedError',
          runId: winner,
        });
      }
    }
  });

  it('ignores idempotency fields on a resilient-start run_started', async () => {
    // A run created by `run_started` never holds a key, so a later keyed
    // start with the same key is not refused by it.
    const resilient = newRunId();
    await createEvent(storage.events, resilient, {
      eventType: 'run_started',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_idem',
        workflowName,
        input: new Uint8Array([1]),
        idempotencyKey: 'order-1',
      },
    } as AnyEventRequest);
    expect((await storage.runs.get(resilient)).idempotencyKey).toBeUndefined();

    await expect(
      createEvent(storage.events, newRunId(), runCreated('order-1'))
    ).resolves.toBeDefined();
  });
});
