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
import { EntityConflictError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRun, updateRun } from '../test-helpers.js';
import {
  CLAIM_ABANDONED_AFTER_MS,
  claimOwnerContent,
  isClaimHeldBy,
  takeOverAbandonedClaim,
} from './claim-owner.js';
import { createStorage } from './index.js';

type EventRequest = Parameters<Storage['events']['create']>[1];

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
  killAt: string
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
  const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once('exit', (_code, signal) => resolve(signal));
    child.once('error', reject);
  });
  child.send({ dataDir: testDir, runId, request, killAt });
  expect(await exited, `child answered ${JSON.stringify(answer)}`).toBe(
    'SIGKILL'
  );
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
  });
});

describe('a claim whose writer may still be working', () => {
  it.each([
    [
      'a live process on this host',
      () =>
        JSON.stringify({
          pid: process.ppid,
          host: os.hostname(),
          process: 'another-process',
          instance: 'another-instance',
        }),
    ],
    [
      'a process on another host',
      () =>
        JSON.stringify({
          pid: 999_999,
          host: 'another-host',
          process: 'another-process',
          instance: 'another-instance',
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
      JSON.stringify({
        pid: deadPid,
        host: os.hostname(),
        process: 'dead-process',
        instance: 'dead-instance',
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

  it('is not taken over from a wait whose writer is alive', async () => {
    await storage.events.create(runId, requests.waitCreated('w'));
    await writeAndKill(requests.waitCompleted('w'), 'claim:.completed');
    await fs.writeFile(
      waitClaim('w', 'completed'),
      JSON.stringify({
        pid: process.ppid,
        host: os.hostname(),
        process: 'another-process',
        instance: 'another-instance',
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

  it('takes over a claim of the same instance at once: its call has ended', async () => {
    const claim = path.join(testDir, 'claim');
    await fs.writeFile(claim, claimOwnerContent('same'));
    expect(await takeOverAbandonedClaim(claim, 'same', orphaned)).toBe(true);
  });
});
