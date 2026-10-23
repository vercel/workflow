import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventIdToSlot, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStorage } from '../storage.js';
import { createRun } from '../test-helpers.js';

const publications = vi.hoisted(() => ({
  attempts: 0,
  failNext: false,
  parkNext: false,
  parked: Promise.resolve(),
  notify: () => {},
  resume: Promise.resolve(),
  release: () => {},
}));

vi.mock('../fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.js')>();
  return {
    ...actual,
    writeExclusive: async (filePath: string, content: string) => {
      if (
        filePath.includes(`${path.sep}events${path.sep}`) &&
        JSON.parse(content).eventType.startsWith('step_')
      ) {
        publications.attempts++;
        if (publications.failNext) {
          publications.failNext = false;
          throw Object.assign(new Error('publication failed'), { code: 'EIO' });
        }
        if (publications.parkNext) {
          publications.parkNext = false;
          publications.notify();
          await publications.resume;
        }
      }
      return actual.writeExclusive(filePath, content);
    },
  };
});

let testDir: string;
let storage: ReturnType<typeof createStorage>;
let runId: string;

beforeEach(async () => {
  publications.attempts = 0;
  publications.failNext = false;
  publications.parkNext = false;
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-step-publication-'));
  storage = createStorage(testDir);
  const run = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: 'test',
    input: new Uint8Array(),
  });
  runId = run.runId;
});

afterEach(async () => {
  publications.release();
  await fs.rm(testDir, { recursive: true, force: true });
});

const stepRequest = (id: number) => ({
  eventType: 'step_created' as const,
  specVersion: SPEC_VERSION_CURRENT,
  correlationId: `step_${id}`,
  eventData: { stepName: `step${id}`, input: new Uint8Array() },
});

async function parkNextPublication() {
  publications.parked = new Promise<void>((resolve) => {
    publications.notify = resolve;
  });
  publications.resume = new Promise<void>((resolve) => {
    publications.release = resolve;
  });
  publications.parkNext = true;
  const write = storage.events.create(runId, stepRequest(0));
  await publications.parked;
  return { write };
}

async function expectDenseHistory(count: number) {
  const { data } = await createStorage(testDir).events.list({
    runId,
    pagination: { limit: 1000 },
  });
  expect(data).toHaveLength(count);
  expect(data.map((event) => eventIdToSlot(event.eventId))).toEqual(
    Array.from({ length: count }, (_, i) => i + 1)
  );
  return data;
}

it.each([
  1, 2,
])('publishes independent concurrent steps once with %i storage instances', async (instances) => {
  const writers = Array.from({ length: instances }, () =>
    createStorage(testDir)
  );
  const width = 20;
  await Promise.all(
    Array.from({ length: width }, (_, i) =>
      writers[i % instances].events.create(runId, stepRequest(i))
    )
  );
  expect(publications.attempts).toBe(width);
  const events = await expectDenseHistory(width + 1);
  expect(
    new Set(events.slice(1).map((event) => event.correlationId)).size
  ).toBe(width);
});

it('coordinates synthetic step creation with concurrent step starts', async () => {
  const width = 20;
  await Promise.all(
    Array.from({ length: width }, (_, i) =>
      storage.events.create(runId, {
        ...stepRequest(i),
        eventType: 'step_started',
      })
    )
  );
  expect(publications.attempts).toBe(width * 2);
  const events = await expectDenseHistory(width * 2 + 1);
  for (let i = 0; i < width; i++) {
    expect(
      events
        .filter((event) => event.correlationId === `step_${i}`)
        .map((event) => event.eventType)
    ).toEqual(['step_created', 'step_started']);
  }
});

it('releases a failed publication turn without reserving a slot', async () => {
  publications.failNext = true;
  await expect(storage.events.create(runId, stepRequest(0))).rejects.toThrow(
    'publication failed'
  );
  await storage.events.create(runId, stepRequest(1));
  await expectDenseHistory(2);
});

it('still arbitrates with publishers outside the step publication turn', async () => {
  const { write } = await parkNextPublication();
  try {
    await createStorage(testDir).events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook_outside',
      eventData: { token: 'outside' },
    });
  } finally {
    publications.release();
    await write;
  }
  expect(publications.attempts).toBe(2);
  const events = await expectDenseHistory(3);
  expect(events.map((event) => event.eventType)).toEqual([
    'run_created',
    'hook_created',
    'step_created',
  ]);
});

it('still bumps after a step in another process takes its candidate slot', async () => {
  const { write } = await parkNextPublication();
  const child = fork(
    fileURLToPath(
      new URL('./step-publication-contention.child.mjs', import.meta.url)
    ),
    [testDir, runId],
    { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child exited with code ${code}`));
      });
    });
  } finally {
    child.kill();
    publications.release();
    await write;
  }
  expect(publications.attempts).toBe(2);
  const events = await expectDenseHistory(3);
  expect(events.slice(1).map((event) => event.correlationId)).toEqual([
    'step_child',
    'step_0',
  ]);
});

it('lets a different run publish while one run holds its turn', async () => {
  const other = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: 'other',
    input: new Uint8Array(),
  });
  const { write } = await parkNextPublication();
  try {
    await storage.events.create(other.runId, stepRequest(1));
  } finally {
    publications.release();
    await write;
  }
  expect(publications.attempts).toBe(2);
  await expectDenseHistory(2);
});
