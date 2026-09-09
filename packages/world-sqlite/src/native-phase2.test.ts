import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type NativeAttributeChangeInput,
  type NativeEventResult,
  NativeSqliteWorld,
} from './native.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'workflow-world-sqlite-native-phase2-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

interface EventFields {
  correlationId?: string;
  payload?: Uint8Array;
  deploymentId?: string;
  workflowName?: string;
  resumeId?: string;
  resumePayloadDigest?: string;
  token?: string;
  tokenRetentionUntilMs?: number;
  isWebhook?: boolean;
  isSystem?: boolean;
  resumeAtMs?: number;
  attributeChanges?: NativeAttributeChangeInput[];
  attributeWriterType?: 'workflow' | 'step';
  attributeWriterStepId?: string;
  attributeWriterAttempt?: number;
}

function createEvent(
  native: InstanceType<typeof NativeSqliteWorld>,
  runId: string,
  eventType: string,
  fields: EventFields = {}
): Promise<NativeEventResult> {
  return native.createEvent(
    runId,
    eventType,
    7,
    undefined,
    undefined,
    fields.correlationId,
    fields.payload,
    fields.deploymentId,
    fields.workflowName,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fields.resumeId,
    fields.resumePayloadDigest,
    fields.token,
    fields.tokenRetentionUntilMs,
    fields.isWebhook,
    fields.isSystem,
    fields.resumeAtMs,
    fields.attributeChanges,
    fields.attributeWriterType,
    fields.attributeWriterStepId,
    fields.attributeWriterAttempt
  );
}

async function createRun(
  native: InstanceType<typeof NativeSqliteWorld>,
  runId: string
): Promise<void> {
  await createEvent(native, runId, 'run_created', {
    payload: new Uint8Array([1]),
    deploymentId: 'local-js',
    workflowName: 'workflow//native-phase2',
  });
}

it('maps Phase 2 events, Hooks, Waits, resume IDs, and clear', async () => {
  const databasePath = path.join(await temporaryDirectory(), 'world.sqlite');
  const native = new NativeSqliteWorld(databasePath);
  await native.migrate();
  await createRun(native, 'wrun_native_phase2');
  await createRun(native, 'wrun_native_conflict');

  const attributes = await createEvent(
    native,
    'wrun_native_phase2',
    'attr_set',
    {
      correlationId: 'attributes-1',
      attributeChanges: [
        { key: 'removed', value: null },
        { key: 'region', value: 'north' },
      ],
      attributeWriterType: 'step',
      attributeWriterStepId: 'step-1',
      attributeWriterAttempt: 2,
    }
  );
  expect(attributes.run?.attributes).toEqual({ region: 'north' });
  expect(attributes.event?.eventData).toMatchObject({
    changes: [
      { key: 'removed', value: null },
      { key: 'region', value: 'north' },
    ],
    writer: { type: 'step', stepId: 'step-1', attempt: 2 },
  });

  const metadataBacking = new Uint8Array([255, 7, 8, 254]);
  const hookCreation = createEvent(
    native,
    'wrun_native_phase2',
    'hook_created',
    {
      correlationId: 'hook-1',
      payload: metadataBacking.subarray(1, 3),
      token: 'shared-token',
      tokenRetentionUntilMs: Date.now() + 60_000,
      isWebhook: false,
      isSystem: true,
    }
  );
  metadataBacking.fill(9);
  const createdHook = (await hookCreation).hook;
  expect(createdHook).toMatchObject({
    runId: 'wrun_native_phase2',
    hookId: 'hook-1',
    token: 'shared-token',
    ownerId: 'local-owner',
    projectId: 'local-project',
    environment: 'local',
    isWebhook: false,
    isSystem: true,
    specVersion: 7,
  });
  expect(Array.from(createdHook?.metadata ?? [])).toEqual([7, 8]);
  await expect(native.getHook('hook-1')).resolves.toMatchObject({
    hookId: 'hook-1',
  });
  await expect(native.getHookByToken('shared-token')).resolves.toMatchObject({
    hookId: 'hook-1',
  });
  await expect(
    native.listHooks('wrun_native_phase2', undefined, 1, false)
  ).resolves.toMatchObject({
    data: [{ hookId: 'hook-1' }],
    hasMore: false,
  });

  const conflict = await createEvent(
    native,
    'wrun_native_conflict',
    'hook_created',
    {
      correlationId: 'hook-conflict',
      token: 'shared-token',
    }
  );
  expect(conflict.event).toMatchObject({
    eventType: 'hook_conflict',
    eventData: {
      token: 'shared-token',
      conflictingRunId: 'wrun_native_phase2',
    },
  });

  const firstResume = await createEvent(
    native,
    'wrun_native_phase2',
    'hook_received',
    {
      correlationId: 'hook-1',
      payload: new Uint8Array([3, 4]),
      token: 'shared-token',
      resumeId: 'resume-1',
      resumePayloadDigest: 'digest-1',
    }
  );
  expect(firstResume.event).toMatchObject({
    resumeId: 'resume-1',
    eventData: { token: 'shared-token' },
  });
  expect(Array.from(firstResume.event?.eventData?.payload ?? [])).toEqual([
    3, 4,
  ]);
  const duplicateResume = await createEvent(
    native,
    'wrun_native_phase2',
    'hook_received',
    {
      correlationId: 'hook-1',
      payload: new Uint8Array([3, 4]),
      token: 'shared-token',
      resumeId: 'resume-1',
      resumePayloadDigest: 'digest-1',
    }
  );
  expect(duplicateResume.event?.eventId).toBe(firstResume.event?.eventId);

  const waiting = await createEvent(
    native,
    'wrun_native_phase2',
    'wait_created',
    { correlationId: 'wait-1', resumeAtMs: 12_345 }
  );
  expect(waiting.wait).toMatchObject({
    waitId: 'wrun_native_phase2-wait-1',
    runId: 'wrun_native_phase2',
    status: 'waiting',
    resumeAtMs: 12_345,
    specVersion: 7,
  });
  const completed = await createEvent(
    native,
    'wrun_native_phase2',
    'wait_completed',
    { correlationId: 'wait-1' }
  );
  expect(completed.wait).toMatchObject({
    waitId: 'wrun_native_phase2-wait-1',
    status: 'completed',
  });
  expect(completed.wait?.completedAtMs).toEqual(expect.any(Number));

  await createEvent(native, 'wrun_native_phase2', 'hook_disposed', {
    correlationId: 'hook-1',
    token: 'shared-token',
  });
  await expect(native.getHook('hook-1')).rejects.toThrow(
    /WORKFLOW_NATIVE_ERROR:(?=.*"kind":"hook_not_found")(?=.*"identifier":"hook-1")/
  );

  await native.clear();
  await expect(native.getRun('wrun_native_phase2')).rejects.toThrow(
    /"kind":"run_not_found"/
  );
  await expect(
    native.listHooks(undefined, undefined, 100, false)
  ).resolves.toMatchObject({ data: [], hasMore: false });
  expect(native.close()).toBe(true);
});
