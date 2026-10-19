import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CreateEventRequest,
  IN_BAND_SEQ_AT_RUN_CREATION,
  isSlotEventId,
  SPEC_VERSION_CURRENT,
  slotToEventId,
} from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runEntityDir, taggedPath, writeJSON } from '../fs.js';
import { createStorage } from '../storage.js';
import { monotonicUlid } from './helpers.js';

let testDir: string;
const releasePublishers: (() => void)[] = [];
const pendingPublishers: Promise<unknown>[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-run-recovery-'));
});

afterEach(async () => {
  for (const release of releasePublishers.splice(0)) release();
  await Promise.allSettled(pendingPublishers.splice(0));
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
    })
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(testDir, { recursive: true, force: true });
});

function originalRequest() {
  return {
    eventType: 'run_created' as const,
    specVersion: SPEC_VERSION_CURRENT - 1,
    eventData: {
      deploymentId: 'dpl_original',
      workflowName: 'workflow//original//entry',
      input: new Uint8Array([1, 2, 3]),
      executionContext: { requestId: 'original', nested: { value: 42 } },
      attributes: { tenant: 'original', $internal: 'preserved' },
      allowReservedAttributes: true as const,
      encryptionPublicKey: `${'A'.repeat(43)}=`,
      dynamicWorkflowCode: new Uint8Array([4, 5, 6]),
    },
  };
}

function redelivery() {
  return {
    eventType: 'run_started' as const,
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_changed',
      workflowName: 'workflow//changed//entry',
      input: new Uint8Array([9]),
      executionContext: { requestId: 'changed' },
      attributes: { tenant: 'changed' },
      encryptionPublicKey: `${'B'.repeat(43)}=`,
      dynamicWorkflowCode: new Uint8Array([8]),
    },
  };
}

async function interruptedRun(tag?: string) {
  // Give the saved run a creation time distinct from the later recovery.
  // Only Date is faked; filesystem operations and timers remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  let created: Awaited<ReturnType<typeof createPendingRun>>;
  try {
    created = await createPendingRun(tag);
  } finally {
    vi.useRealTimers();
  }
  const eventPath = taggedPath(
    testDir,
    runEntityDir('events', created.run.runId),
    `${created.run.runId}-${created.event.eventId}`,
    tag
  );
  // Model the interrupted publish without deleting the original payload.
  // A new storage instance below avoids serving the hidden event from cache.
  await fs.rename(eventPath, `${eventPath}.tmp.interrupted`);
  return created;
}

async function createPendingRun(tag?: string) {
  const result = await createStorage(testDir, tag).events.create(
    null,
    originalRequest()
  );
  assert(result.run);
  assert(result.event);
  return { run: result.run, event: result.event };
}

async function journal(runId: string, tag?: string) {
  return (
    await createStorage(testDir, tag).events.list({
      runId,
      pagination: { sortOrder: 'asc' },
    })
  ).data;
}

function expectSingleCreation(eventTypes: string[]) {
  expect(eventTypes[0]).toBe('run_created');
  expect(eventTypes.filter((type) => type === 'run_created')).toHaveLength(1);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pauseCreationPublishes(count = 1) {
  const gates = Array.from({ length: count }, () => {
    const reached = deferred();
    const resume = deferred();
    releasePublishers.push(resume.resolve);
    return { reached, resume };
  });
  const link = fs.link.bind(fs);
  let next = 0;
  vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (
      next < gates.length &&
      String(destination).includes(`${path.sep}events${path.sep}`) &&
      JSON.parse(await fs.readFile(source, 'utf8')).eventType === 'run_created'
    ) {
      const gate = gates[next++];
      gate.reached.resolve();
      await gate.resume.promise;
    }
    // Keep the actual atomic hard-link publication and disk contents real.
    return link(source, destination);
  });
  return gates;
}

function track<T>(promise: Promise<T>) {
  pendingPublishers.push(promise);
  // Observe a rejection immediately while another writer is paused.
  return Promise.allSettled([promise]);
}

async function storageProcess(runId: string) {
  const child = fork(
    fileURLToPath(
      new URL('./run-creation-recovery.child.mjs', import.meta.url)
    ),
    [testDir, runId, String(SPEC_VERSION_CURRENT)],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
    }
  );
  children.push(child);
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Storage process exited (${code}) before ready`))
    );
    child.once('message', (message) => {
      if (message === 'ready') resolve();
      else reject(new Error(`Unexpected storage message: ${message}`));
    });
  });
  await ready;
  return {
    child,
    start: (crash?: {
      request: ReturnType<typeof originalRequest>;
      pauseAt: 'before-link' | 'after-link';
    }) =>
      new Promise<{ status: string; events?: string[] }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`Storage process exited (${code}) without a result`))
        );
        child.once('message', resolve);
        child.send({ type: 'go', ...crash });
      }),
  };
}

it.each([
  { tag: undefined, withRedeliveryData: true },
  { tag: 'recovery', withRedeliveryData: false },
])('restores the original run before starting (tag: $tag, redelivery data: $withRedeliveryData)', async ({
  tag,
  withRedeliveryData,
}) => {
  const original = await interruptedRun(tag);
  const storage = createStorage(testDir, tag);
  const started = await storage.events.create(
    original.run.runId,
    withRedeliveryData
      ? redelivery()
      : { eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }
  );
  const events = await journal(original.run.runId, tag);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  expect(events[0]).toMatchObject({
    runId: original.run.runId,
    specVersion: SPEC_VERSION_CURRENT - 1,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    eventData: {
      deploymentId: 'dpl_original',
      workflowName: 'workflow//original//entry',
      input: new Uint8Array([1, 2, 3]),
      executionContext: { requestId: 'original', nested: { value: 42 } },
      attributes: { tenant: 'original', $internal: 'preserved' },
      encryptionPublicKey: `${'A'.repeat(43)}=`,
    },
  });
  // Dynamic code belongs only on the run record, as on normal creation.
  expect(events[0].eventData).not.toHaveProperty('dynamicWorkflowCode');
  expect(await storage.runs.get(original.run.runId)).toEqual({
    ...original.run,
    status: 'running',
    startedAt: expect.any(Date),
    updatedAt: expect.any(Date),
  });
  expect(started.events?.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
});

it('converges concurrent recovery through independent storage instances', async () => {
  const original = await interruptedRun();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      createStorage(testDir).events.create(original.run.runId, redelivery())
    )
  );
  const types = (await journal(original.run.runId)).map(
    (event) => event.eventType
  );
  expectSingleCreation(types);
  expect(types).toContain('run_started');
  for (const result of results) {
    assert(result.events);
    expectSingleCreation(result.events.map((event) => event.eventType));
    expect(result.run).toMatchObject({
      status: 'running',
      deploymentId: 'dpl_original',
      input: new Uint8Array([1, 2, 3]),
    });
  }
});

it.each<{
  request: CreateEventRequest;
  status: string;
}>([
  {
    request: {
      eventType: 'attr_set',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        changes: [{ key: 'updated', value: 'before-start' }],
        writer: { type: 'workflow' },
      },
    },
    status: 'pending',
  },
  {
    request: { eventType: 'run_cancelled', specVersion: SPEC_VERSION_CURRENT },
    status: 'cancelled',
  },
  {
    request: {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { error: new Uint8Array([7]) },
    },
    status: 'failed',
  },
])('restores creation before $request.eventType can take the first slot', async ({
  request,
  status,
}) => {
  const original = await interruptedRun();
  const result = await createStorage(testDir).events.create(
    original.run.runId,
    request
  );
  const events = await journal(original.run.runId);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    request.eventType,
  ]);
  expect(events[0].eventData).toMatchObject({
    input: original.run.input,
    attributes: original.run.attributes,
  });
  expect(result.run?.status).toBe(status);
  if (request.eventType === 'attr_set') {
    const started = await createStorage(testDir).events.create(
      original.run.runId,
      redelivery()
    );
    expect(started.run).toMatchObject({
      status: 'running',
      attributes: { tenant: 'original', updated: 'before-start' },
    });
  }
});

it.each([
  {
    eventType: 'run_cancelled' as const,
    reason: 'the original input is missing',
    status: 'cancelled',
  },
  {
    eventType: 'run_failed' as const,
    reason: 'the event log is not empty',
    status: 'failed',
  },
])('refuses unsafe recovery but allows $eventType when $reason', async ({
  eventType,
  reason,
  status,
}) => {
  const original = await interruptedRun();
  if (eventType === 'run_cancelled') {
    await writeJSON(
      taggedPath(testDir, 'runs', original.run.runId),
      { ...original.run, input: undefined },
      { overwrite: true }
    );
  } else {
    const eventId = slotToEventId(1);
    // A prior writer already consumed the empty history. Recovery must not
    // invent the original attributes from the run's now-mutable metadata.
    await writeJSON(
      taggedPath(
        testDir,
        runEntityDir('events', original.run.runId),
        `${original.run.runId}-${eventId}`
      ),
      {
        ...original.event,
        eventType: 'attr_set',
        eventId,
        eventData: {
          changes: [{ key: 'updated', value: 'before-start' }],
          writer: { type: 'workflow' },
        },
      }
    );
  }
  const before = await journal(original.run.runId);
  const storage = createStorage(testDir);
  const runBefore = await storage.runs.get(original.run.runId);
  await expect(
    storage.events.create(original.run.runId, redelivery())
  ).rejects.toThrow(reason);
  expect(await storage.runs.get(original.run.runId)).toEqual(runBefore);
  expect(await journal(original.run.runId)).toEqual(before);
  const result = await storage.events.create(
    original.run.runId,
    eventType === 'run_failed'
      ? {
          eventType,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { error: new Uint8Array([7]) },
        }
      : { eventType, specVersion: SPEC_VERSION_CURRENT }
  );
  expect(result.run?.status).toBe(status);
  const events = await journal(original.run.runId);
  expect(events.slice(0, before.length)).toEqual(before);
  expect(events.map((event) => event.eventType)).toEqual([
    ...before.map((event) => event.eventType),
    eventType,
  ]);
});

it.each([
  { name: 'pending ULID run', ulids: true, running: false, created: true },
  {
    name: 'running ULID run with a late creation',
    ulids: true,
    running: true,
    created: true,
  },
  {
    name: 'running slot run with a late creation',
    ulids: false,
    running: true,
    created: true,
  },
  {
    name: 'running run without a creation event',
    ulids: false,
    running: true,
    created: false,
  },
])('preserves existing history for a $name', async ({
  ulids,
  running,
  created,
}) => {
  const original = await createPendingRun();
  const directory = runEntityDir('events', original.run.runId);
  await fs.unlink(
    taggedPath(
      testDir,
      directory,
      `${original.run.runId}-${original.event.eventId}`
    )
  );
  const types = [
    ...(running ? ['run_started'] : []),
    ...(created ? ['run_created'] : []),
  ];
  for (const [index, eventType] of types.entries()) {
    const eventId = ulids
      ? `evnt_${monotonicUlid()}`
      : slotToEventId(index + 1);
    await writeJSON(
      taggedPath(testDir, directory, `${original.run.runId}-${eventId}`),
      {
        ...original.event,
        eventType,
        eventId,
        eventData:
          eventType === 'run_created' ? original.event.eventData : undefined,
      }
    );
  }
  if (running) {
    await writeJSON(
      taggedPath(testDir, 'runs', original.run.runId),
      { ...original.run, status: 'running', startedAt: original.run.createdAt },
      { overwrite: true }
    );
  }
  const storage = createStorage(testDir);
  const before = await journal(original.run.runId);
  const runBefore = await storage.runs.get(original.run.runId);
  // Observe real filesystem reads: a replay that skips preloading must not
  // parse the history just to check whether it needs creation recovery.
  const reads = vi.spyOn(fs, 'readFile');
  const started = await storage.events.create(
    original.run.runId,
    redelivery(),
    { skipPreload: true }
  );
  if (running) {
    expect(started.run).toEqual(runBefore);
    expect(started.event).toBeUndefined();
    expect(
      reads.mock.calls.filter(([file]) =>
        String(file).includes(`${path.sep}events${path.sep}`)
      )
    ).toEqual([]);
  }
  reads.mockRestore();
  const events = await journal(original.run.runId);
  expect(events.slice(0, before.length)).toEqual(before);
  expect(events.map((event) => event.eventType)).toEqual(
    running ? types : ['run_created', 'run_started']
  );
  expect(events.every((event) => isSlotEventId(event.eventId) === !ulids)).toBe(
    true
  );
  const repeated = await storage.events.create(
    original.run.runId,
    redelivery()
  );
  expect(repeated.event).toBeUndefined();
  expect(repeated.events).toEqual(events);
});

it('returns complete history to recovery in separate OS processes', async () => {
  const original = await interruptedRun();
  const recover = await Promise.all(
    Array.from({ length: 3 }, () => storageProcess(original.run.runId))
  );
  const results = await Promise.all(recover.map(({ start }) => start()));
  for (const result of results) {
    expect(result).toMatchObject({
      status: 'running',
      deploymentId: 'dpl_original',
      input: [1, 2, 3],
    });
    assert(result.events);
    expectSingleCreation(result.events);
  }
  const types = (await journal(original.run.runId)).map(
    (event) => event.eventType
  );
  expectSingleCreation(types);
  expect(types).toContain('run_started');
}, 30_000);

it.each([
  'before-link',
  'after-link',
] as const)('recovers after SIGKILL at %s without duplicating creation', async (pauseAt) => {
  const runId = `wrun_${monotonicUlid()}`;
  const creator = await storageProcess(runId);
  expect(await creator.start({ request: originalRequest(), pauseAt })).toEqual({
    status: 'paused',
  });
  const exited = new Promise((resolve) => {
    creator.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  expect(creator.child.kill('SIGKILL')).toBe(true);
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });

  const before = await journal(runId);
  expect(before.map((event) => event.eventType)).toEqual(
    pauseAt === 'before-link' ? [] : ['run_created']
  );
  const saved = await createStorage(testDir).runs.get(runId);
  expect(saved.status).toBe('pending');
  // Abrupt exit leaves the real temp file behind; it must not become history.
  const files = await fs.readdir(
    path.join(testDir, runEntityDir('events', runId))
  );
  expect(files.some((file) => file.includes('.tmp.'))).toBe(true);

  const recovery = await storageProcess(runId);
  expect(await recovery.start()).toMatchObject({
    status: 'running',
    events: ['run_created', 'run_started'],
    deploymentId: 'dpl_original',
    input: [1, 2, 3],
  });
  const events = await journal(runId);
  expect(events[0]).toMatchObject({
    createdAt: saved.createdAt,
    specVersion: saved.specVersion,
    eventData: { input: saved.input, attributes: saved.attributes },
  });
  if (pauseAt === 'after-link') expect(events[0]).toEqual(before[0]);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
}, 30_000);

it('recovers under the in-band fence without counting a repeated start', async () => {
  const original = await interruptedRun();
  const storage = createStorage(testDir);
  const started = await storage.events.create(
    original.run.runId,
    redelivery(),
    {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    }
  );
  expect(started.allocated).toBe(1);
  expect(started.events?.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  const repeated = await storage.events.create(
    original.run.runId,
    redelivery(),
    {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 1,
      skipPreload: true,
    }
  );
  expect(repeated.allocated).toBe(0);
  expect(repeated.event).toBeUndefined();
  expect(repeated.events).toBeUndefined();
  expect(repeated.run).toEqual(started.run);
  expect(
    (await storage.events.list({ runId: original.run.runId })).snapshot
  ).toEqual({
    seq: 2,
    seqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 1,
  });
});

it.each([
  'run_created',
  'run_started',
] as const)('does not duplicate creation when recovery beats the original %s writer', async (eventType) => {
  const [gate] = pauseCreationPublishes();
  const runId = `wrun_${monotonicUlid()}`;
  const storage = createStorage(testDir);
  const original =
    eventType === 'run_created'
      ? track(storage.events.create(runId, originalRequest()))
      : track(
          storage.events.create(runId, { ...originalRequest(), eventType })
        );
  await gate.reached.promise;
  const recovery = createStorage(testDir);
  await recovery.events.create(runId, redelivery());
  gate.resume.resolve();
  const outcome = (await original)[0];
  const events = await journal(runId);
  expectSingleCreation(events.map((event) => event.eventType));
  expect(events[0].eventData).toMatchObject({
    deploymentId: 'dpl_original',
    input: new Uint8Array([1, 2, 3]),
  });
  if (eventType === 'run_created') {
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { name: 'EntityConflictError' },
    });
  } else {
    assert(outcome.status === 'fulfilled');
    assert(outcome.value.events);
    expectSingleCreation(outcome.value.events.map((event) => event.eventType));
  }
  expect(await recovery.runs.get(runId)).toMatchObject({
    status: 'running',
    deploymentId: 'dpl_original',
    workflowName: 'workflow//original//entry',
    input: new Uint8Array([1, 2, 3]),
    dynamicWorkflowCode: new Uint8Array([4, 5, 6]),
  });
});

it('publishes creation after an unrelated event wins its slot', async () => {
  const [gate] = pauseCreationPublishes();
  const runId = `wrun_${monotonicUlid()}`;
  const original = track(
    createStorage(testDir).events.create(runId, originalRequest())
  );
  await gate.reached.promise;
  // Older writers can publish attributes before the creator finishes. Stage
  // that on-disk state so the test continues to cover upgrade compatibility.
  const saved = await createStorage(testDir).runs.get(runId);
  await writeJSON(
    taggedPath(testDir, 'runs', runId),
    { ...saved, attributes: { ...saved.attributes, updated: 'before-start' } },
    { overwrite: true }
  );
  const eventId = slotToEventId(1);
  await writeJSON(
    taggedPath(testDir, runEntityDir('events', runId), `${runId}-${eventId}`),
    {
      eventType: 'attr_set',
      runId,
      eventId,
      createdAt: new Date(),
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        changes: [{ key: 'updated', value: 'before-start' }],
        writer: { type: 'workflow' },
      },
    }
  );
  gate.resume.resolve();
  const outcome = (await original)[0];
  expect(outcome.status).toBe('fulfilled');

  const storage = createStorage(testDir);
  const started = await storage.events.create(runId, redelivery());
  expect((await journal(runId)).map((event) => event.eventType)).toEqual([
    'attr_set',
    'run_created',
    'run_started',
  ]);
  expect(started.run).toMatchObject({
    status: 'running',
    input: new Uint8Array([1, 2, 3]),
    attributes: { tenant: 'original', updated: 'before-start' },
  });
});

it('adopts the original event when its writer beats the recovery publish', async () => {
  const [creatorGate, recoveryGate] = pauseCreationPublishes(2);
  const runId = `wrun_${monotonicUlid()}`;
  const original = track(
    createStorage(testDir).events.create(runId, originalRequest())
  );
  await creatorGate.reached.promise;
  const recovery = track(
    createStorage(testDir).events.create(runId, redelivery())
  );
  await Promise.race([
    recoveryGate.reached.promise,
    recovery.then(() => {
      throw new Error('Recovery finished without restoring the creation event');
    }),
  ]);
  creatorGate.resume.resolve();
  const created = (await original)[0];
  expect(created.status).toBe('fulfilled');
  recoveryGate.resume.resolve();
  expect((await recovery)[0].status).toBe('fulfilled');
  const events = await journal(runId);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  if (created.status === 'fulfilled')
    expect(events[0]).toEqual(created.value.event);
});

it('keeps the run pending when restoring its creation event fails', async () => {
  const original = await interruptedRun();
  const link = fs.link.bind(fs);
  const failure = new Error('injected creation-event publication failure');
  vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (
      String(destination).includes(`${path.sep}events${path.sep}`) &&
      JSON.parse(await fs.readFile(source, 'utf8')).eventType === 'run_created'
    ) {
      throw failure;
    }
    return link(source, destination);
  });
  const storage = createStorage(testDir);
  await expect(
    storage.events.create(original.run.runId, redelivery())
  ).rejects.toThrow(failure);
  expect(await storage.runs.get(original.run.runId)).toEqual(original.run);
  expect(await journal(original.run.runId)).toEqual([]);
  vi.restoreAllMocks();
  await createStorage(testDir).events.create(original.run.runId, redelivery());
  expect(
    (await journal(original.run.runId)).map((event) => event.eventType)
  ).toEqual(['run_created', 'run_started']);
});
