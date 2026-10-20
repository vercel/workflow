import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AnyEventRequest,
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
  slotToEventId,
} from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runEntityDir, taggedPath, writeJSON } from '../fs.js';
import { createStorage } from '../storage.js';
import { monotonicUlid } from './helpers.js';

const publisherGate = vi.hoisted(() => ({
  armed: false,
  reached: Promise.resolve(),
  notifyReached: () => {},
  resume: Promise.resolve(),
  release: () => {},
}));

vi.mock('../fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.js')>();
  return {
    ...actual,
    writeExclusive: async (filePath: string, content: string) => {
      if (
        publisherGate.armed &&
        filePath.includes(`${path.sep}events${path.sep}`) &&
        JSON.parse(content).eventType === 'run_created'
      ) {
        publisherGate.armed = false;
        publisherGate.notifyReached();
        await publisherGate.resume;
      }
      return actual.writeExclusive(filePath, content);
    },
  };
});

let testDir: string;
const children: ChildProcess[] = [];
const childScript = fileURLToPath(
  new URL('./run-created-recovery.child.mjs', import.meta.url)
);

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'world-local-run-created-recovery-')
  );
});

afterEach(async () => {
  publisherGate.release();
  publisherGate.armed = false;
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    })
  );
  vi.restoreAllMocks();
  await fs.rm(testDir, { recursive: true, force: true });
});

function originalCreation() {
  return {
    eventType: 'run_created' as const,
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_original',
      workflowName: 'workflow//original//entry',
      input: new Uint8Array([1, 2, 3]),
      executionContext: { requestId: 'original' },
      attributes: { tenant: 'original', $reserved: 'preserved' },
      allowReservedAttributes: true as const,
      encryptionPublicKey: `${'A'.repeat(43)}=`,
      dynamicWorkflowCode: new Uint8Array([4, 5, 6]),
    },
  };
}

function changedRedelivery() {
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

async function createInterruptedRun() {
  const created = await createStorage(testDir).events.create(
    null,
    originalCreation()
  );
  assert(created.run);
  assert(created.event);
  const eventPath = taggedPath(
    testDir,
    runEntityDir('events', created.run.runId),
    `${created.run.runId}-${created.event.eventId}`
  );
  await fs.rename(eventPath, `${eventPath}.tmp.interrupted`);
  return { run: created.run, event: created.event };
}

async function listEvents(runId: string) {
  return (
    await createStorage(testDir).events.list({
      runId,
      pagination: { limit: 100, sortOrder: 'asc' },
    })
  ).data;
}

function armPublisherGate() {
  publisherGate.reached = new Promise<void>((resolve) => {
    publisherGate.notifyReached = resolve;
  });
  publisherGate.resume = new Promise<void>((resolve) => {
    publisherGate.release = resolve;
  });
  publisherGate.armed = true;
}

function nextMessage<T>(child: ChildProcess): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    child.once('message', (message) => resolve(message as T));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `Child exited before responding (code ${code}, signal ${signal})`
        )
      );
    });
  });
}

async function spawnStarter(runId: string) {
  const child = fork(
    childScript,
    ['start', testDir, runId, String(SPEC_VERSION_CURRENT)],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }
  );
  children.push(child);
  expect(await nextMessage(child)).toEqual({ status: 'ready' });
  return () => {
    const answer = nextMessage<{
      status: string;
      runStatus?: string;
      input?: number[];
      message?: string;
    }>(child);
    child.send('go');
    return answer;
  };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation hung for ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// TODO: These tests check the world-local storage invariant (exactly one
// run_created in slot 1, restored from the run record). They don't run a
// workflow end to end through core replay, where #4836 actually surfaced
// ("has no run_created event"). Add a more robust test system for data
// migrations / cross-version upgrades that covers replay after interrupted
// run creation.
it('restores an interrupted run_created from the original run record before starting', async () => {
  const original = await createInterruptedRun();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const result = await createStorage(testDir).events.create(
    original.run.runId,
    changedRedelivery()
  );

  const events = await listEvents(original.run.runId);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  expect(events[0]).toMatchObject({
    runId: original.run.runId,
    createdAt: original.run.createdAt,
    specVersion: original.run.specVersion,
    eventData: {
      deploymentId: original.run.deploymentId,
      workflowName: original.run.workflowName,
      input: original.run.input,
      executionContext: original.run.executionContext,
      attributes: original.run.attributes,
      encryptionPublicKey: original.run.encryptionPublicKey,
    },
  });
  expect(events[0].eventData).not.toHaveProperty('dynamicWorkflowCode');
  expect(result.run).toMatchObject({
    status: 'running',
    deploymentId: 'dpl_original',
    workflowName: 'workflow//original//entry',
    input: new Uint8Array([1, 2, 3]),
  });
  expect(warning).toHaveBeenCalledWith(
    `[world-local] restored missing run_created for ${original.run.runId} (creation was interrupted or is still in flight)`
  );
});

it('uses the persisted run record when a redelivery carries different data', async () => {
  const original = await createInterruptedRun();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  await createStorage(testDir).events.create(
    original.run.runId,
    changedRedelivery()
  );

  const [creation] = await listEvents(original.run.runId);
  expect(creation.eventData).toMatchObject({
    deploymentId: 'dpl_original',
    workflowName: 'workflow//original//entry',
    input: new Uint8Array([1, 2, 3]),
    executionContext: { requestId: 'original' },
    attributes: { tenant: 'original', $reserved: 'preserved' },
    encryptionPublicKey: `${'A'.repeat(43)}=`,
  });
  expect(creation.eventData).not.toHaveProperty('allowReservedAttributes');
  expect(creation.eventData).not.toHaveProperty('dynamicWorkflowCode');
});

it('converges 8 storage instances and 3 OS processes on one run_created', async () => {
  const original = await createInterruptedRun();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const starters = await Promise.all(
    Array.from({ length: 3 }, () => spawnStarter(original.run.runId))
  );

  const [localResults, processResults] = await Promise.all([
    Promise.all(
      Array.from({ length: 8 }, () =>
        createStorage(testDir).events.create(
          original.run.runId,
          changedRedelivery()
        )
      )
    ),
    Promise.all(starters.map((start) => start())),
  ]);

  expect(localResults).toHaveLength(8);
  expect(localResults.every((result) => result.run?.status === 'running')).toBe(
    true
  );
  expect(processResults).toEqual(
    Array.from({ length: 3 }, () => ({
      status: 'started',
      runStatus: 'running',
      input: [1, 2, 3],
    }))
  );
  const events = await listEvents(original.run.runId);
  expect(events[0].eventType).toBe('run_created');
  expect(
    events.filter((event) => event.eventType === 'run_created')
  ).toHaveLength(1);
});

it('lets recovery win a paused original publish without duplicating run_created', async () => {
  const runId = `wrun_${monotonicUlid()}`;
  armPublisherGate();
  const originalPublish = Promise.allSettled([
    createStorage(testDir).events.create(runId, originalCreation()),
  ]);
  await publisherGate.reached;

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const repaired = await createStorage(testDir).events.create(
    runId,
    changedRedelivery()
  );
  publisherGate.release();
  const [originalResult] = await originalPublish;

  expect(repaired.run?.status).toBe('running');
  expect(originalResult).toMatchObject({
    status: 'rejected',
    reason: { name: 'EntityConflictError' },
  });
  const events = await listEvents(runId);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  expect(
    events.filter((event) => event.eventType === 'run_created')
  ).toHaveLength(1);
});

it('does not duplicate run_created when repair overtakes resilient start', async () => {
  const runId = `wrun_${monotonicUlid()}`;
  armPublisherGate();
  const resilientStart = createStorage(testDir).events.create(
    runId,
    changedRedelivery()
  );
  await publisherGate.reached;

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const repaired = await createStorage(testDir).events.create(
    runId,
    changedRedelivery()
  );
  publisherGate.release();
  const original = await resilientStart;

  expect(original.run?.status).toBe('running');
  expect(repaired.run?.status).toBe('running');
  const events = await listEvents(runId);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  expect(
    events.filter((event) => event.eventType === 'run_created')
  ).toHaveLength(1);
});

it('rejects a missing input without changing the pending run or empty log', async () => {
  const original = await createInterruptedRun();
  const runPath = taggedPath(testDir, 'runs', original.run.runId);
  await writeJSON(
    runPath,
    { ...original.run, input: undefined },
    {
      overwrite: true,
    }
  );
  const storage = createStorage(testDir);
  const before = await storage.runs.get(original.run.runId);

  await expect(
    storage.events.create(original.run.runId, changedRedelivery())
  ).rejects.toThrow('the original input is missing');

  expect(await storage.runs.get(original.run.runId)).toEqual(before);
  expect(await listEvents(original.run.runId)).toEqual([]);
});

it('rejects a non-empty log without run_created and leaves it unchanged', async () => {
  const original = await createInterruptedRun();
  const eventId = slotToEventId(FIRST_EVENT_SLOT);
  const unexpectedEvent = {
    eventType: 'attr_set' as const,
    runId: original.run.runId,
    eventId,
    createdAt: new Date(),
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      changes: [{ key: 'unexpected', value: 'first' }],
      writer: { type: 'workflow' as const },
    },
  };
  await writeJSON(
    taggedPath(
      testDir,
      runEntityDir('events', original.run.runId),
      `${original.run.runId}-${eventId}`
    ),
    unexpectedEvent
  );
  const storage = createStorage(testDir);
  const before = await storage.runs.get(original.run.runId);

  await expect(
    storage.events.create(original.run.runId, changedRedelivery())
  ).rejects.toThrow('the event log is not empty');

  expect(await storage.runs.get(original.run.runId)).toEqual(before);
  expect(await listEvents(original.run.runId)).toEqual([unexpectedEvent]);
});

it.each<{
  name: string;
  request: AnyEventRequest;
  status: string;
}>([
  {
    name: 'run_cancelled',
    request: {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    },
    status: 'cancelled',
  },
  {
    name: 'run_failed',
    request: {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { error: new Uint8Array([7]) },
    },
    status: 'failed',
  },
])('$name continues when run_created repair fails', async ({
  request,
  status,
}) => {
  const nonEmpty = await createInterruptedRun();
  const eventId = slotToEventId(FIRST_EVENT_SLOT);
  await writeJSON(
    taggedPath(
      testDir,
      runEntityDir('events', nonEmpty.run.runId),
      `${nonEmpty.run.runId}-${eventId}`
    ),
    {
      eventType: 'attr_set',
      runId: nonEmpty.run.runId,
      eventId,
      createdAt: new Date(),
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        changes: [{ key: 'unexpected', value: 'first' }],
        writer: { type: 'workflow' },
      },
    }
  );

  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const nonEmptyResult = await createStorage(testDir).events.create(
    nonEmpty.run.runId,
    request
  );
  expect(nonEmptyResult.run?.status).toBe(status);
  expect(warning).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining(
      'the event log is not empty (its first event is "attr_set")'
    )
  );

  const missingInput = await createInterruptedRun();
  await writeJSON(
    taggedPath(testDir, 'runs', missingInput.run.runId),
    { ...missingInput.run, input: undefined },
    { overwrite: true }
  );
  const missingInputResult = await createStorage(testDir).events.create(
    missingInput.run.runId,
    request
  );
  expect(missingInputResult.run?.status).toBe(status);
  expect(warning).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining('the original input is missing')
  );
});

it.each<{
  name: string;
  request: AnyEventRequest;
  status: string;
}>([
  {
    name: 'attr_set',
    request: {
      eventType: 'attr_set',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        changes: [{ key: 'repaired', value: 'yes' }],
        writer: { type: 'workflow' },
      },
    },
    status: 'pending',
  },
  {
    name: 'run_cancelled',
    request: {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    },
    status: 'cancelled',
  },
  {
    name: 'run_failed',
    request: {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { error: new Uint8Array([7]) },
    },
    status: 'failed',
  },
])('repairs before $name can become the first event', async ({
  request,
  status,
}) => {
  const original = await createInterruptedRun();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const result = await createStorage(testDir).events.create(
    original.run.runId,
    request
  );

  expect(result.run?.status).toBe(status);
  expect(
    (await listEvents(original.run.runId)).map((event) => event.eventType)
  ).toEqual(['run_created', request.eventType]);
});

it('does not read event files when run_started reaches a running run', async () => {
  const storage = createStorage(testDir);
  const created = await storage.events.create(null, originalCreation());
  assert(created.run);
  await storage.events.create(created.run.runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
  });
  const reads = vi.spyOn(fs, 'readFile');

  const repeated = await createStorage(testDir).events.create(
    created.run.runId,
    changedRedelivery(),
    { skipPreload: true }
  );

  expect(repeated.event).toBeUndefined();
  expect(repeated.run?.status).toBe('running');
  expect(
    reads.mock.calls.filter(([file]) =>
      String(file).includes(`${path.sep}events${path.sep}`)
    )
  ).toEqual([]);
});

it('keeps normal creation and missing-record resilient creation unchanged', async () => {
  const normal = await createStorage(testDir).events.create(
    null,
    originalCreation()
  );
  assert(normal.run);
  expect(
    (await listEvents(normal.run.runId)).map((event) => event.eventType)
  ).toEqual(['run_created']);
  expect(normal.run.status).toBe('pending');

  const resilientRunId = `wrun_${monotonicUlid()}`;
  const resilient = await createStorage(testDir).events.create(resilientRunId, {
    ...changedRedelivery(),
    eventData: {
      ...changedRedelivery().eventData,
      attributes: { $reserved: 'preserved' },
      allowReservedAttributes: true,
    },
  });
  expect(resilient.run).toMatchObject({
    runId: resilientRunId,
    status: 'running',
    deploymentId: 'dpl_changed',
    input: new Uint8Array([9]),
    attributes: { $reserved: 'preserved' },
  });
  const resilientEvents = await listEvents(resilientRunId);
  expect(resilientEvents.map((event) => event.eventType)).toEqual([
    'run_created',
    'run_started',
  ]);
  expect(resilientEvents[0].eventData).toMatchObject({
    allowReservedAttributes: true,
    attributes: { $reserved: 'preserved' },
  });
});

it.each([
  'before-event-temp',
  'after-event-temp',
  'before-event-link',
  'after-event-link',
])('recovers without hanging after SIGKILL at %s', async (stage) => {
  const runId = `wrun_${monotonicUlid()}`;
  const child = fork(
    childScript,
    ['crash-create', testDir, runId, String(SPEC_VERSION_CURRENT), stage],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }
  );
  children.push(child);
  expect(await withTimeout(nextMessage(child))).toEqual({
    status: 'checkpoint',
    stage,
  });
  child.kill('SIGKILL');
  await withTimeout(waitForExit(child));

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovered = await withTimeout(
    createStorage(testDir).events.create(runId, changedRedelivery())
  );
  expect(recovered.run).toMatchObject({
    status: 'running',
    input: new Uint8Array([1, 2, 3]),
  });
  const events = await listEvents(runId);
  expect(events[0].eventType).toBe('run_created');
  expect(
    events.filter((event) => event.eventType === 'run_created')
  ).toHaveLength(1);
});
