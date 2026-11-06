/**
 * A step or wait change takes a claim file, writes its entity, then writes
 * its event. A process killed between the claim and the event used to leave
 * the run stuck for good: every later write of that change lost the claim and
 * was refused, and nothing ever wrote the event.
 *
 * Each crash below is a real SIGKILL of a second process at the exact write.
 * The next write must finish the change, exactly once. A claim whose writer
 * may still be working must be left alone until it is
 * CLAIM_ABANDONED_AFTER_MS old.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  EntityConflictError,
  InBandSupersededError,
  TooEarlyError,
} from '@workflow/errors';
import {
  IN_BAND_SEQ_AT_RUN_CREATION,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRun, updateRun } from '../test-helpers.js';
import {
  CLAIM_ABANDONED_AFTER_MS,
  claimOwnerContent,
  isClaimHeldBy,
  takeOverAbandonedClaim,
} from './claim-owner.js';
import { createStorage } from './index.js';

type EventRequest = Parameters<Storage['events']['create']>[1];

// Parks this process's next `.terminal` claim write, so a test can let
// another process finish the step and die between this write's validation
// and its claim.
const gate = vi.hoisted(() => ({
  armed: false,
  parked: () => {},
  release: () => {},
}));

vi.mock('../fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.js')>();
  return {
    ...actual,
    writeExclusive: async (filePath: string, data: string) => {
      if (gate.armed && filePath.endsWith('.terminal')) {
        gate.armed = false;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
          gate.parked();
        });
      }
      return actual.writeExclusive(filePath, data);
    },
  };
});

const SPEC = SPEC_VERSION_CURRENT;
const input = new Uint8Array([1]);
const requests = {
  stepCreated: (id: string): EventRequest => ({
    eventType: 'step_created',
    specVersion: SPEC,
    correlationId: id,
    eventData: { stepName: 'step', input },
  }),
  lazyStepStarted: (id: string): EventRequest => ({
    eventType: 'step_started',
    specVersion: SPEC,
    correlationId: id,
    eventData: { stepName: 'step', input },
  }),
  stepStarted: (id: string): EventRequest => ({
    eventType: 'step_started',
    specVersion: SPEC,
    correlationId: id,
    eventData: { stepName: 'step' },
  }),
  // `mark` tells apart the payloads of two writers of the same step.
  stepCompleted: (id: string, mark = 1): EventRequest => ({
    eventType: 'step_completed',
    specVersion: SPEC,
    correlationId: id,
    eventData: { stepName: 'step', result: new Uint8Array([mark]) },
  }),
  stepFailed: (id: string, mark = 1): EventRequest => ({
    eventType: 'step_failed',
    specVersion: SPEC,
    correlationId: id,
    eventData: { stepName: 'step', error: new Uint8Array([mark]) },
  }),
  waitCreated: (id: string): EventRequest => ({
    eventType: 'wait_created',
    specVersion: SPEC,
    correlationId: id,
    eventData: { resumeAt: new Date(0) },
  }),
  waitCompleted: (id: string): EventRequest => ({
    eventType: 'wait_completed',
    specVersion: SPEC,
    correlationId: id,
  }),
};

let testDir: string;
let storage: Storage;
let runId: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-claim-repair-'));
  storage = createStorage(testDir);
  const run = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: 'workflow',
    input,
  });
  runId = run.runId;
  await updateRun(storage, runId, 'run_started');
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const childScript = fileURLToPath(
  new URL('./claim-repair.child.mjs', import.meta.url)
);

/**
 * Writes `request` from a second process that is SIGKILLed at `killAt` (see
 * claim-repair.child.mjs), and returns that process's pid, now dead.
 */
async function writeAndKill(
  request: EventRequest,
  killAt: string,
  params?: Parameters<Storage['events']['create']>[2]
): Promise<number> {
  const child = fork(childScript, [], {
    // Node's own type stripping, nothing inherited from the test runner.
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let answer: unknown;
  child.on('message', (message) => {
    answer = message;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  child.send({ dataDir: testDir, runId, request, params, killAt });
  const { code, signal } = await exited;
  // On Windows a process's SIGKILL of itself is a TerminateProcess: it exits
  // with code 1 and no signal. The child only ever answers when it was not
  // killed, so no answer and that exit still mean it died at `killAt`.
  const killed =
    signal === 'SIGKILL' ||
    (process.platform === 'win32' &&
      code === 1 &&
      signal === null &&
      answer === undefined);
  expect(
    killed,
    `child answered ${JSON.stringify(answer)}, exited with code ${code}, signal ${signal}`
  ).toBe(true);
  return child.pid as number;
}

async function eventsOf(correlationId: string) {
  const page = await createStorage(testDir).events.listByCorrelationId({
    runId,
    correlationId,
    resolveData: 'all',
  });
  return page.data;
}

async function eventTypesOf(correlationId: string): Promise<string[]> {
  return (await eventsOf(correlationId)).map((event) => event.eventType);
}

function stepClaim(stepId: string, kind: 'created' | 'terminal'): string {
  return path.join(testDir, '.locks', 'steps', `${runId}-${stepId}.${kind}`);
}

function waitClaim(waitId: string, kind: 'created' | 'completed'): string {
  return path.join(testDir, '.locks', 'waits', `${runId}-${waitId}.${kind}`);
}

async function ageClaim(claimPath: string): Promise<void> {
  const past = new Date(Date.now() - CLAIM_ABANDONED_AFTER_MS - 1_000);
  await fs.utimes(claimPath, past, past);
}

/** A claim owner like the ones this thread writes, with `changes` applied. */
function ownerLikeThisProcess(changes: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(claimOwnerContent('x')), ...changes });
}

async function startStep(id: string): Promise<void> {
  await storage.events.create(runId, requests.stepCreated(id));
  await storage.events.create(runId, requests.stepStarted(id));
}

describe('a process killed after a claim and before its event', () => {
  it.each([
    ['after the claim', 'claim:.created'],
    ['after the step entity', 'event:step_created'],
  ])('a lazy step_started is finished by the next one (killed %s)', async (_, killAt) => {
    await writeAndKill(requests.lazyStepStarted('s'), killAt);

    const result = await storage.events.create(
      runId,
      requests.lazyStepStarted('s')
    );

    expect(result.stepCreated).toBe(true);
    expect(result.step?.status).toBe('running');
    expect(await eventTypesOf('s')).toEqual(['step_created', 'step_started']);
    await expect(
      storage.events.create(runId, requests.lazyStepStarted('s'))
    ).rejects.toThrow(EntityConflictError);
  });

  it.each([
    ['after the claim', 'claim:.created'],
    ['after the step entity', 'event:step_started'],
  ])('a lazy step_started of a spec 9 run is finished by the next one (killed %s)', async (_, killAt) => {
    // A single-orchestrator run records the creation on step_started alone,
    // so a kill before that event leaves a `running` step with no event.
    const run = await createRun(
      storage,
      { deploymentId: 'dpl_test', workflowName: 'workflow', input },
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    runId = run.runId;
    await updateRun(storage, runId, 'run_started');
    const request = {
      ...requests.lazyStepStarted('s'),
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    } as EventRequest;
    await writeAndKill(request, killAt);

    const result = await storage.events.create(runId, request);

    expect(result.stepCreated).toBe(true);
    expect(result.step?.status).toBe('running');
    expect(result.step?.attempt).toBe(1);
    expect(await eventTypesOf('s')).toEqual(['step_started']);
    await expect(storage.events.create(runId, request)).rejects.toThrow(
      EntityConflictError
    );
  });

  it.each([
    ['after the claim', 'claim:.created'],
    ['after the step entity', 'event:step_created'],
  ])('a step_created is finished by the next one (killed %s)', async (_, killAt) => {
    await writeAndKill(requests.stepCreated('s'), killAt);

    const result = await storage.events.create(
      runId,
      requests.stepCreated('s')
    );

    expect(result.step?.status).toBe('pending');
    expect(await eventTypesOf('s')).toEqual(['step_created']);
    await expect(
      storage.events.create(runId, requests.stepCreated('s'))
    ).rejects.toThrow(EntityConflictError);
  });

  it('a step_completed killed after the claim is finished by the next one', async () => {
    await startStep('s');
    await writeAndKill(requests.stepCompleted('s', 1), 'claim:.terminal');

    const result = await storage.events.create(
      runId,
      requests.stepCompleted('s', 2)
    );

    expect(result.step?.status).toBe('completed');
    expect(result.step?.output).toEqual(new Uint8Array([2]));
    expect(await eventTypesOf('s')).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
  });

  it.each([
    ['step_completed', requests.stepCompleted, 'result'],
    ['step_failed', requests.stepFailed, 'error'],
  ] as const)('a %s killed after the step entity is written by the next step_started, from the saved step', async (eventType, terminal, field) => {
    await startStep('s');
    await writeAndKill(terminal('s', 1), `event:${eventType}`);

    // The redelivered start is refused, as before: the step is finished.
    await expect(
      storage.events.create(runId, requests.stepStarted('s'))
    ).rejects.toThrow('terminal state');

    const events = await eventsOf('s');
    expect(events.map((event) => event.eventType)).toEqual([
      'step_created',
      'step_started',
      eventType,
    ]);
    const written = events[2] as { eventData?: Record<string, unknown> };
    expect(written.eventData?.[field]).toEqual(new Uint8Array([1]));
    // A later terminal write is refused, and adds nothing.
    await expect(
      storage.events.create(runId, terminal('s', 2))
    ).rejects.toThrow(EntityConflictError);
    expect(await eventTypesOf('s')).toHaveLength(3);
  });

  it.each([
    ['after the claim', 'claim:.created'],
    ['after the wait entity', 'event:wait_created'],
  ])('a wait_created is finished by the next one (killed %s)', async (_, killAt) => {
    await writeAndKill(requests.waitCreated('w'), killAt);

    const result = await storage.events.create(
      runId,
      requests.waitCreated('w')
    );

    expect(result.wait?.status).toBe('waiting');
    expect(await eventTypesOf('w')).toEqual(['wait_created']);
  });

  it.each([
    ['after the claim', 'claim:.completed'],
    ['after the wait entity', 'event:wait_completed'],
  ])('a wait_completed is finished by the next one (killed %s)', async (_, killAt) => {
    await storage.events.create(runId, requests.waitCreated('w'));
    await writeAndKill(requests.waitCompleted('w'), killAt);

    const result = await storage.events.create(
      runId,
      requests.waitCompleted('w')
    );

    expect(result.wait?.status).toBe('completed');
    expect(await eventTypesOf('w')).toEqual(['wait_created', 'wait_completed']);
    await expect(
      storage.events.create(runId, requests.waitCompleted('w'))
    ).rejects.toThrow('already completed');
  });

  it('a takeover cut short before it rewrote the claim is taken over in turn', async () => {
    await startStep('s');
    await writeAndKill(requests.stepCompleted('s', 1), 'claim:.terminal');
    // The next writer takes the claim over and dies right after its takeover
    // marker, before it rewrote the claim.
    await writeAndKill(requests.stepCompleted('s', 2), 'claim:.takeover.');

    const result = await storage.events.create(
      runId,
      requests.stepCompleted('s', 3)
    );

    expect(result.step?.output).toEqual(new Uint8Array([3]));
    expect(await eventTypesOf('s')).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
  });

  it('a step finished by a writer that died after this write read it keeps the saved result', async () => {
    await startStep('s');
    const parked = new Promise<void>((resolve) => {
      gate.parked = resolve;
    });
    gate.armed = true;
    // Reads the step as running, then waits at its claim.
    const late = storage.events.create(runId, requests.stepCompleted('s', 2));
    await parked;
    // Meanwhile another process saves the step as completed and dies.
    await writeAndKill(requests.stepCompleted('s', 1), 'event:step_completed');
    gate.release();

    await expect(late).rejects.toThrow('terminal state');
    const events = await eventsOf('s');
    expect(events.map((event) => event.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    const written = events[2] as { eventData?: { result?: unknown } };
    expect(written.eventData?.result).toEqual(new Uint8Array([1]));
    const step = await storage.steps.get(runId, 's', { resolveData: 'all' });
    expect(step.output).toEqual(new Uint8Array([1]));
  });

  it('two writers that find the same orphaned claim write one event', async () => {
    await startStep('s');
    await writeAndKill(requests.stepCompleted('s', 1), 'claim:.terminal');

    // Two storage instances behave like two processes.
    const results = await Promise.allSettled([
      createStorage(testDir).events.create(
        runId,
        requests.stepCompleted('s', 2)
      ),
      createStorage(testDir).events.create(
        runId,
        requests.stepCompleted('s', 3)
      ),
    ]);

    const written = results.filter((r) => r.status === 'fulfilled');
    expect(written).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(EntityConflictError.is(refused?.reason)).toBe(true);
    const events = await eventsOf('s');
    expect(events.filter((e) => e.eventType === 'step_completed')).toHaveLength(
      1
    );
    const winner = (written[0] as PromiseFulfilledResult<{ step?: unknown }>)
      .value.step as { output: Uint8Array };
    const step = await storage.steps.get(runId, 's', { resolveData: 'all' });
    expect(step.output).toEqual(winner.output);
    // The takeover markers are removed once the claim is rewritten.
    const locks = await fs.readdir(path.join(testDir, '.locks', 'steps'));
    expect(locks.filter((name) => name.includes('.takeover.'))).toEqual([]);
  });
});

describe('a claim whose writer may still be working', () => {
  it.each([
    [
      'a live process on this host',
      () =>
        ownerLikeThisProcess({
          pid: process.ppid,
          token: 'another-process',
        }),
    ],
    [
      'a process on another host',
      () =>
        JSON.stringify({
          pid: 999_999,
          host: 'another-host',
          token: 'another-process',
        }),
    ],
    [
      'another thread of this process',
      () =>
        ownerLikeThisProcess({
          token: 'another-thread',
        }),
    ],
    [
      'a process in another pid namespace on this host',
      () =>
        ownerLikeThisProcess({
          pid: 999_999,
          pidNamespace: 'pid:[1]',
          token: 'another-process',
        }),
    ],
    ['no one (written by an older version)', () => ''],
  ])('is left alone until it is old, when it names %s', async (_, owner) => {
    await startStep('s');
    await writeAndKill(requests.stepCompleted('s', 1), 'claim:.terminal');
    const claim = stepClaim('s', 'terminal');
    await fs.writeFile(claim, owner());

    await expect(
      storage.events.create(runId, requests.stepCompleted('s', 2))
    ).rejects.toThrow('terminal state');
    expect(await eventTypesOf('s')).not.toContain('step_completed');

    await ageClaim(claim);
    const result = await storage.events.create(
      runId,
      requests.stepCompleted('s', 2)
    );
    expect(result.step?.status).toBe('completed');
    expect(await eventTypesOf('s')).toContain('step_completed');
  });

  it('is left alone when its event is in the log, even if its writer is dead', async () => {
    await startStep('s');
    await storage.events.create(runId, requests.stepCompleted('s', 1));
    const deadPid = await writeAndKill(
      requests.waitCreated('unrelated'),
      'claim:.created'
    );
    await fs.writeFile(
      stepClaim('s', 'terminal'),
      ownerLikeThisProcess({
        pid: deadPid,
        token: 'dead-process',
      })
    );

    await expect(
      storage.events.create(runId, requests.stepCompleted('s', 2))
    ).rejects.toThrow('terminal state');
    await expect(
      storage.events.create(runId, requests.stepStarted('s'))
    ).rejects.toThrow('terminal state');
    expect(await eventTypesOf('s')).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
  });

  it.each([
    [
      'a process on another host',
      () =>
        JSON.stringify({
          pid: 999_999,
          host: 'another-host',
          token: 'another-process',
        }),
    ],
    ['no one (written by an older version)', () => ''],
  ])('redelivers a step_started that finds a finished step without its event until the claim is old, when it names %s', async (_, owner) => {
    await startStep('s');
    await writeAndKill(requests.stepCompleted('s', 1), 'event:step_completed');
    const claim = stepClaim('s', 'terminal');
    await fs.writeFile(claim, owner());

    // Refused as `skipped`, the start would be dropped and nothing would
    // deliver this step again; TooEarlyError has the runtime redeliver it.
    const early = await storage.events
      .create(runId, requests.stepStarted('s'))
      .catch((error: unknown) => error);
    expect(TooEarlyError.is(early)).toBe(true);
    expect((early as TooEarlyError).retryAfter).toBeGreaterThan(0);
    expect((early as TooEarlyError).retryAfter).toBeLessThanOrEqual(
      CLAIM_ABANDONED_AFTER_MS / 1000
    );
    expect(await eventTypesOf('s')).toEqual(['step_created', 'step_started']);

    await ageClaim(claim);
    await expect(
      storage.events.create(runId, requests.stepStarted('s'))
    ).rejects.toThrow(EntityConflictError);
    const events = await eventsOf('s');
    expect(events.map((event) => event.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    expect(events[2]?.eventData).toMatchObject({ result: new Uint8Array([1]) });
  });

  it('is not taken over from a wait whose writer is alive', async () => {
    await storage.events.create(runId, requests.waitCreated('w'));
    await writeAndKill(requests.waitCompleted('w'), 'claim:.completed');
    await fs.writeFile(
      waitClaim('w', 'completed'),
      ownerLikeThisProcess({
        pid: process.ppid,
        token: 'another-process',
      })
    );

    await expect(
      storage.events.create(runId, requests.waitCompleted('w'))
    ).rejects.toThrow('already completed');
    expect(await eventTypesOf('w')).toEqual(['wait_created']);
  });
});

describe('takeOverAbandonedClaim', () => {
  const orphaned = async () => true;

  it('moves an old claim to its taker, so the writer it replaced stops', async () => {
    const claim = path.join(testDir, 'claim');
    await fs.writeFile(claim, claimOwnerContent('first'));
    expect(await takeOverAbandonedClaim(claim, 'second', orphaned)).toBe(false);

    await ageClaim(claim);
    expect(await takeOverAbandonedClaim(claim, 'second', orphaned)).toBe(true);
    expect(await isClaimHeldBy(claim, 'first')).toBe(false);
    expect(await isClaimHeldBy(claim, 'second')).toBe(true);
  });

  it('leaves a claim with this pid and another token to the age rule, like the fence lock', async () => {
    // Another thread of this process, or an earlier process that had this
    // pid: they can't be told apart.
    const claim = path.join(testDir, 'claim');
    await fs.writeFile(claim, ownerLikeThisProcess({ token: 'other' }));
    expect(await takeOverAbandonedClaim(claim, 'second', orphaned)).toBe(false);

    await ageClaim(claim);
    expect(await takeOverAbandonedClaim(claim, 'second', orphaned)).toBe(true);
  });

  it('takes over a claim from a realm that booted before `abandonedBefore`, whoever wrote it', async () => {
    const claim = path.join(testDir, 'claim');
    // Another instance of this process (this pid, another token) whose realm
    // booted at 1000: the fence lock's rules can't tell if it is alive.
    await fs.writeFile(claim, ownerLikeThisProcess({ token: '1000.other' }));
    expect(
      await takeOverAbandonedClaim(claim, 'second', orphaned, {
        abandonedBefore: 1000,
      })
    ).toBe(false);
    expect(
      await takeOverAbandonedClaim(claim, 'second', orphaned, {
        abandonedBefore: 1001,
      })
    ).toBe(true);
  });

  it('dates a claim that names no realm by its mtime, with slack for a lagging file clock', async () => {
    const claim = path.join(testDir, 'claim');
    await fs.writeFile(claim, '');
    const written = (await fs.stat(claim)).mtimeMs;
    expect(
      await takeOverAbandonedClaim(claim, 'second', orphaned, {
        abandonedBefore: written + 1_000,
      })
    ).toBe(false);
    expect(
      await takeOverAbandonedClaim(claim, 'second', orphaned, {
        abandonedBefore: written + 2_001,
      })
    ).toBe(true);
  });

  it('takes over a claim of the same instance at once: its call has ended', async () => {
    const claim = path.join(testDir, 'claim');
    await fs.writeFile(claim, claimOwnerContent('same'));
    expect(await takeOverAbandonedClaim(claim, 'same', orphaned)).toBe(true);
  });
});

describe('a writer in another worker thread of this process', () => {
  it('keeps its claim: the other thread is refused, and one step_completed lands', async () => {
    await startStep('s');
    const worker = new Worker(
      new URL('./claim-repair.worker.mjs', import.meta.url),
      {
        // Node's own type stripping, nothing inherited from the test runner.
        execArgv: [],
        workerData: {
          dataDir: testDir,
          runId,
          request: requests.stepCompleted('s', 2),
          pauseAfter: `${runId}-s.terminal`,
        },
      }
    );
    const messages: { status: string; message?: string }[] = [];
    const next = () =>
      new Promise<{ status: string; message?: string }>((resolve, reject) => {
        worker.once('message', (message) => {
          messages.push(message);
          resolve(message);
        });
        worker.once('error', reject);
      });
    try {
      expect(await next()).toEqual({ status: 'claimed' });

      // Same pid, another thread's token: the fence lock's rules can't tell
      // it from a dead earlier process, so it is left to the age rule.
      await expect(
        storage.events.create(runId, requests.stepCompleted('s', 1))
      ).rejects.toThrow(EntityConflictError);

      const written = next();
      worker.postMessage('go');
      expect(await written).toEqual({ status: 'written' });
    } finally {
      await worker.terminate();
    }
    const completed = (await eventsOf('s')).filter(
      (event) => event.eventType === 'step_completed'
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.eventData).toMatchObject({
      result: new Uint8Array([2]),
    });
  });
});

describe('a spec 9 in-band write that repairs, then refuses', () => {
  it('is refused as superseded, and the fence counts the event it wrote', async () => {
    const run = await createRun(
      storage,
      { deploymentId: 'dpl_test', workflowName: 'workflow', input },
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    runId = run.runId;
    const spec9 = <T extends EventRequest>(request: T): T => ({
      ...request,
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    const seqInBand = async () =>
      (await createStorage(testDir).events.list({ runId })).snapshot
        ?.seqInBand ?? IN_BAND_SEQ_AT_RUN_CREATION;
    const inBand = async () => ({
      inBand: true,
      expectedSeqInBand: await seqInBand(),
    });
    await storage.events.create(
      runId,
      spec9(requests.stepCreated('s')),
      await inBand()
    );
    await storage.events.create(
      runId,
      spec9(requests.stepStarted('s')),
      await inBand()
    );

    // The orchestrator's in-band step_completed dies after the step is saved
    // as completed, before its event: the fence counted it as ambiguous.
    const beforeCrash = await seqInBand();
    await writeAndKill(
      spec9(requests.stepCompleted('s', 1)),
      'event:step_completed',
      await inBand()
    );
    // The restarted orchestrator's first in-band write settles the crashed
    // write as one that may have landed, and is superseded; it reloads.
    await expect(
      storage.events.create(runId, spec9(requests.stepStarted('s')), {
        inBand: true,
        expectedSeqInBand: beforeCrash,
      })
    ).rejects.toThrow(InBandSupersededError);
    const afterCrash = await seqInBand();
    expect(afterCrash).toBe(beforeCrash + 1);

    // Its in-band step_started then writes the missing event from the saved
    // step. The orchestrator hasn't seen that event: a conflict would fail
    // the run, so the write is refused as superseded, and the fence counts
    // the event, so the orchestrator reloads and finds the step finished.
    await expect(
      storage.events.create(
        runId,
        spec9(requests.stepStarted('s')),
        await inBand()
      )
    ).rejects.toThrow(InBandSupersededError);
    expect(await seqInBand()).toBe(afterCrash + 1);
    expect((await eventsOf('s')).map((event) => event.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);

    // A writer that loaded the log after the repair writes in-band again.
    await storage.events.create(
      runId,
      spec9(requests.waitCreated('w')),
      await inBand()
    );
    expect(await seqInBand()).toBe(afterCrash + 2);
  });
});
