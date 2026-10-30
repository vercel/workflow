import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalWorld } from '../index.js';
import { createWorld } from '../index.js';

const STEP_ID = 'step_01M5X07JGS8QR43T59B8S9XMMA';
const STEP_NAME = 'step//synthetic//probe';
const SPEC_VERSION = 8;

async function listPersistedEventTypes(
  dataDir: string,
  runId: string
): Promise<string[]> {
  const dir = path.join(dataDir, 'events', runId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const types: string[] = [];
  for (const file of files.sort()) {
    if (!file.startsWith(`${runId}-`) || !file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const parsed = JSON.parse(raw) as { eventType?: string };
    if (parsed.eventType) types.push(parsed.eventType);
  }
  return types;
}

async function readStepJson(
  dataDir: string,
  runId: string,
  stepId: string
): Promise<{ status?: string } | null> {
  const file = path.join(dataDir, 'steps', runId, `${runId}-${stepId}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function markerExists(
  dataDir: string,
  runId: string,
  stepId: string,
  suffix: '.created' | '.terminal'
): Promise<boolean> {
  const file = path.join(
    dataDir,
    '.locks',
    'steps',
    `${runId}-${stepId}${suffix}`
  );
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe('world-local step crash consistency (#5083)', () => {
  let dataDir: string;
  let world: LocalWorld;
  let runId: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-crash-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
    await world.start?.();
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION,
      eventData: {
        deploymentId: 'dpl_synthetic_crash_probe',
        workflowName: 'workflow//synthetic//probe',
        input: new Uint8Array(),
      },
    });
    if (!created.run) {
      throw new Error('run_created did not return a run');
    }
    runId = created.run.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION,
    });
  });
  afterEach(async () => {
    await world.close?.();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('case 1: create marker published, canonical step record and step_created event absent', async () => {
    const markerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${STEP_ID}.created`
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(markerPath, staleTime, staleTime);

    expect(await markerExists(dataDir, runId, STEP_ID, '.created')).toBe(true);
    expect(await readStepJson(dataDir, runId, STEP_ID)).toBeNull();
    expect(await listPersistedEventTypes(dataDir, runId)).not.toContain(
      'step_created'
    );

    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });

    expect(await readStepJson(dataDir, runId, STEP_ID)).not.toBeNull();
    expect(await listPersistedEventTypes(dataDir, runId)).toContain(
      'step_created'
    );
  });

  it('case 1b: a fresh marker throws TooEarlyError so the message is redelivered', async () => {
    const markerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${STEP_ID}.created`
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '');
    // Fresh (do NOT backdate mtime).

    await expect(
      world.events.create(runId, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
        eventData: { stepName: STEP_NAME, input: new Uint8Array() },
      })
    ).rejects.toMatchObject({ name: 'TooEarlyError', retryAfter: 5 });
  });

  it('case 2: terminal marker published, step still running, step_completed event absent', async () => {
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const terminalMarkerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${STEP_ID}.terminal`
    );
    await fs.mkdir(path.dirname(terminalMarkerPath), { recursive: true });
    await fs.writeFile(terminalMarkerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(terminalMarkerPath, staleTime, staleTime);

    expect(await markerExists(dataDir, runId, STEP_ID, '.terminal')).toBe(true);
    expect((await readStepJson(dataDir, runId, STEP_ID))?.status).toBe(
      'running'
    );
    expect(await listPersistedEventTypes(dataDir, runId)).not.toContain(
      'step_completed'
    );

    await world.events.create(runId, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { result: new Uint8Array() },
    });

    expect((await readStepJson(dataDir, runId, STEP_ID))?.status).toBe(
      'completed'
    );
    expect(await listPersistedEventTypes(dataDir, runId)).toContain(
      'step_completed'
    );
  });

  it('case 3: completed step record present, step_completed event absent', async () => {
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const stepFilePath = path.join(
      dataDir,
      'steps',
      runId,
      `${runId}-${STEP_ID}.json`
    );
    const step = JSON.parse(await fs.readFile(stepFilePath, 'utf8'));
    step.status = 'completed';
    step.output = new Uint8Array();
    step.completedAt = new Date().toISOString();
    await fs.writeFile(stepFilePath, JSON.stringify(step, null, 2));

    expect((await readStepJson(dataDir, runId, STEP_ID))?.status).toBe(
      'completed'
    );
    expect(await listPersistedEventTypes(dataDir, runId)).not.toContain(
      'step_completed'
    );

    await world.events.create(runId, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { result: new Uint8Array() },
    });

    expect(await listPersistedEventTypes(dataDir, runId)).toContain(
      'step_completed'
    );
  });

  it('case 3b: step_started on a completed step repairs the missing step_completed event', async () => {
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const stepFilePath = path.join(
      dataDir,
      'steps',
      runId,
      `${runId}-${STEP_ID}.json`
    );
    const step = JSON.parse(await fs.readFile(stepFilePath, 'utf8'));
    step.status = 'completed';
    step.output = new Uint8Array();
    step.completedAt = new Date().toISOString();
    await fs.writeFile(stepFilePath, JSON.stringify(step, null, 2));

    const terminalMarkerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${STEP_ID}.terminal`
    );
    await fs.mkdir(path.dirname(terminalMarkerPath), { recursive: true });
    await fs.writeFile(terminalMarkerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(terminalMarkerPath, staleTime, staleTime);

    await expect(
      world.events.create(runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
      })
    ).rejects.toMatchObject({ name: 'EntityConflictError' });

    const types = await listPersistedEventTypes(dataDir, runId);
    expect(types.filter((t) => t === 'step_completed')).toHaveLength(1);
  });

  it('case 3c: step_started repairs the event, then step_completed is a benign duplicate', async () => {
    // Setup the case-3 state: completed record, stale .terminal marker,
    // missing step_completed event.
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const stepFilePath = path.join(
      dataDir,
      'steps',
      runId,
      `${runId}-${STEP_ID}.json`
    );
    const step = JSON.parse(await fs.readFile(stepFilePath, 'utf8'));
    step.status = 'completed';
    step.output = new Uint8Array();
    step.completedAt = new Date().toISOString();
    await fs.writeFile(stepFilePath, JSON.stringify(step, null, 2));

    const terminalMarkerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${STEP_ID}.terminal`
    );
    await fs.mkdir(path.dirname(terminalMarkerPath), { recursive: true });
    await fs.writeFile(terminalMarkerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(terminalMarkerPath, staleTime, staleTime);

    // 1. The runtime sends step_started first. It repairs the missing
    //    step_completed event, then throws the conflict so the body is
    //    not re-run.
    await expect(
      world.events.create(runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
      })
    ).rejects.toMatchObject({ name: 'EntityConflictError' });

    const afterStart = await listPersistedEventTypes(dataDir, runId);
    expect(afterStart.filter((t) => t === 'step_completed')).toHaveLength(1);

    // 2. If a step_completed is now delivered (a retry, or a different
    //    path), it must be a benign duplicate: the record is completed
    //    and the event exists. No second event.
    await expect(
      world.events.create(runId, {
        eventType: 'step_completed',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
        eventData: { result: new Uint8Array() },
      })
    ).rejects.toMatchObject({ name: 'EntityConflictError' });

    const afterCompleted = await listPersistedEventTypes(dataDir, runId);
    expect(afterCompleted.filter((t) => t === 'step_completed')).toHaveLength(
      1
    );
  });

  it('two Worlds sharing a dataDir recover the same stale marker without duplicates', async () => {
    const world2 = createWorld({ dataDir, recoverActiveRuns: false });
    await world2.start?.();

    try {
      const markerPath = path.join(
        dataDir,
        '.locks',
        'steps',
        `${runId}-${STEP_ID}.created`
      );
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, '');
      const staleTime = new Date(Date.now() - 60_000);
      await fs.utimes(markerPath, staleTime, staleTime);

      const results = await Promise.allSettled([
        world.events.create(runId, {
          eventType: 'step_created',
          specVersion: SPEC_VERSION,
          correlationId: STEP_ID,
          eventData: { stepName: STEP_NAME, input: new Uint8Array() },
        }),
        world2.events.create(runId, {
          eventType: 'step_created',
          specVersion: SPEC_VERSION,
          correlationId: STEP_ID,
          eventData: { stepName: STEP_NAME, input: new Uint8Array() },
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.name).toBe(
        'EntityConflictError'
      );

      expect(await readStepJson(dataDir, runId, STEP_ID)).not.toBeNull();
      const types = await listPersistedEventTypes(dataDir, runId);
      expect(types.filter((t) => t === 'step_created')).toHaveLength(1);
    } finally {
      await world2.close?.();
    }
  });
});
