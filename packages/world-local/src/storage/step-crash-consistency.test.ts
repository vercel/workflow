import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalWorld } from '../index.js';
import { createWorld } from '../index.js';

const RUN_ID = 'wrun_01M5X07JGST5PKGPFYWA8RZBWS';
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

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-crash-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
    await world.start?.();
    await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION,
      eventData: {
        deploymentId: 'dpl_synthetic_crash_probe',
        workflowName: 'workflow//synthetic//probe',
        input: new Uint8Array(),
      },
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
      `${RUN_ID}-${STEP_ID}.created`
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(markerPath, staleTime, staleTime);

    expect(await markerExists(dataDir, RUN_ID, STEP_ID, '.created')).toBe(true);
    expect(await readStepJson(dataDir, RUN_ID, STEP_ID)).toBeNull();
    expect(await listPersistedEventTypes(dataDir, RUN_ID)).not.toContain(
      'step_created'
    );

    await world.events.create(RUN_ID, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });

    expect(await readStepJson(dataDir, RUN_ID, STEP_ID)).not.toBeNull();
    expect(await listPersistedEventTypes(dataDir, RUN_ID)).toContain(
      'step_created'
    );
  });

  it('case 2: terminal marker published, step still running, step_completed event absent', async () => {
    await world.events.create(RUN_ID, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(RUN_ID, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const terminalMarkerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${RUN_ID}-${STEP_ID}.terminal`
    );
    await fs.mkdir(path.dirname(terminalMarkerPath), { recursive: true });
    await fs.writeFile(terminalMarkerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(terminalMarkerPath, staleTime, staleTime);

    expect(await markerExists(dataDir, RUN_ID, STEP_ID, '.terminal')).toBe(
      true
    );
    expect((await readStepJson(dataDir, RUN_ID, STEP_ID))?.status).toBe(
      'running'
    );
    expect(await listPersistedEventTypes(dataDir, RUN_ID)).not.toContain(
      'step_completed'
    );

    await world.events.create(RUN_ID, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { result: new Uint8Array() },
    });

    expect((await readStepJson(dataDir, RUN_ID, STEP_ID))?.status).toBe(
      'completed'
    );
    expect(await listPersistedEventTypes(dataDir, RUN_ID)).toContain(
      'step_completed'
    );
  });

  it('case 3: completed step record present, step_completed event absent', async () => {
    await world.events.create(RUN_ID, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { stepName: STEP_NAME, input: new Uint8Array() },
    });
    await world.events.create(RUN_ID, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
    });

    const stepFilePath = path.join(
      dataDir,
      'steps',
      RUN_ID,
      `${RUN_ID}-${STEP_ID}.json`
    );
    const step = JSON.parse(await fs.readFile(stepFilePath, 'utf8'));
    step.status = 'completed';
    step.output = new Uint8Array();
    step.completedAt = new Date().toISOString();
    await fs.writeFile(stepFilePath, JSON.stringify(step, null, 2));

    expect((await readStepJson(dataDir, RUN_ID, STEP_ID))?.status).toBe(
      'completed'
    );
    expect(await listPersistedEventTypes(dataDir, RUN_ID)).not.toContain(
      'step_completed'
    );

    await world.events.create(RUN_ID, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION,
      correlationId: STEP_ID,
      eventData: { result: new Uint8Array() },
    });

    expect(await listPersistedEventTypes(dataDir, RUN_ID)).toContain(
      'step_completed'
    );
  });

  it('concurrent writers: only one succeeds, no duplicate records or events', async () => {
    const results = await Promise.allSettled([
      world.events.create(RUN_ID, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
        eventData: { stepName: STEP_NAME, input: new Uint8Array() },
      }),
      world.events.create(RUN_ID, {
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

    expect(await readStepJson(dataDir, RUN_ID, STEP_ID)).not.toBeNull();
    const types = await listPersistedEventTypes(dataDir, RUN_ID);
    expect(types.filter((t) => t === 'step_created')).toHaveLength(1);
  });

  it('concurrent Worlds recovering the same stale marker produce one event', async () => {
    const world2 = createWorld({ dataDir, recoverActiveRuns: false });
    await world2.start?.();

    const markerPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${RUN_ID}-${STEP_ID}.created`
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(markerPath, staleTime, staleTime);

    const results = await Promise.allSettled([
      world.events.create(RUN_ID, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
        eventData: { stepName: STEP_NAME, input: new Uint8Array() },
      }),
      world2.events.create(RUN_ID, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION,
        correlationId: STEP_ID,
        eventData: { stepName: STEP_NAME, input: new Uint8Array() },
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason.name
    ).toBe('EntityConflictError');

    const types = await listPersistedEventTypes(dataDir, RUN_ID);
    expect(types.filter((t) => t === 'step_created')).toHaveLength(1);

    await world2.close?.();
  });
});
