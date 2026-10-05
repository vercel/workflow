import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRun } from '../test-helpers.js';
import { createStorage } from './index.js';

// Park the claim owner at publication so a second instance adopts its claim
// and publishes first. Both still use the real exclusive filesystem writer.
const gate = vi.hoisted(() => ({
  armed: false,
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
        gate.armed &&
        filePath.includes(`${path.sep}events${path.sep}`) &&
        JSON.parse(content).eventType === 'hook_created'
      ) {
        gate.armed = false;
        gate.notify();
        await gate.resume;
      }
      return actual.writeExclusive(filePath, content);
    },
  };
});
let testDir: string;
afterEach(async () => {
  gate.release();
  gate.armed = false;
  if (testDir) await fs.rm(testDir, { recursive: true, force: true });
});
it('does not republish when a hook claim adopter wins the event slot', async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-create-publish-'));
  const owner = createStorage(testDir);
  const adopter = createStorage(testDir);
  const run = await createRun(owner, {
    deploymentId: 'dpl_test',
    workflowName: 'test',
    input: new Uint8Array(),
  });
  const request = {
    eventType: 'hook_created' as const,
    correlationId: 'hook_race',
    eventData: { token: 'token_race' },
  };
  gate.parked = new Promise<void>((resolve) => {
    gate.notify = resolve;
  });
  gate.resume = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  gate.armed = true;
  const first = owner.events.create(run.runId, request);
  // Attach the rejection handler before allowing either writer to finish.
  const settled = Promise.allSettled([first]);
  await gate.parked;
  await adopter.events.create(run.runId, {
    ...request,
    eventData: { ...request.eventData, metadata: { publisher: 'adopter' } },
  });
  gate.release();
  const result = await settled;
  const { data } = await createStorage(testDir).events.list({
    runId: run.runId,
    pagination: { limit: 1000 },
  });
  expect(data.filter((e) => e.eventType === 'hook_created')).toHaveLength(1);
  expect(result[0]).toMatchObject({
    status: 'rejected',
    reason: { name: 'EntityConflictError' },
  });
  expect(await owner.hooks.get('hook_race')).toMatchObject({
    metadata: { publisher: 'adopter' },
  });
});

it('still bumps a hook creation past an unrelated event', async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-create-publish-'));
  const owner = createStorage(testDir);
  const other = createStorage(testDir);
  const run = await createRun(owner, {
    deploymentId: 'dpl_test',
    workflowName: 'test',
    input: new Uint8Array(),
  });
  gate.parked = new Promise<void>((resolve) => {
    gate.notify = resolve;
  });
  gate.resume = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  gate.armed = true;
  const first = owner.events.create(run.runId, {
    eventType: 'hook_created',
    correlationId: 'hook_first',
    eventData: { token: 'token_first' },
  });
  const settled = Promise.allSettled([first]);
  await gate.parked;
  await other.events.create(run.runId, {
    eventType: 'hook_created',
    correlationId: 'hook_other',
    eventData: { token: 'token_other' },
  });
  gate.release();
  expect((await settled)[0].status).toBe('fulfilled');
  const { data } = await createStorage(testDir).events.list({
    runId: run.runId,
  });
  expect(
    data
      .filter((e) => e.eventType === 'hook_created')
      .map((e) => e.correlationId)
  ).toEqual(['hook_other', 'hook_first']);
});
