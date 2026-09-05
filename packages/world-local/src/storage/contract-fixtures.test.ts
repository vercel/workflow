import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Event, WorkflowRun } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';

type FixtureBytes = { $bytes: string };

type RunProjection = {
  runId: string;
  status: WorkflowRun['status'];
  deploymentId: string;
  workflowName: string;
  specVersion: number;
  input: FixtureBytes;
  executionContext: Record<string, unknown>;
  attributes: Record<string, string>;
  encryptionPublicKey: string;
  startedAtPresent: boolean;
};

type EventProjection = {
  slot: number;
  eventType: Event['eventType'];
  specVersion: number;
  eventDataPresent: boolean;
  eventData?: Record<string, unknown>;
};

type ResilientRunStartFixture = {
  fixtureVersion: 1;
  name: string;
  requires: ['run-started-preload'];
  persistedSpecVersion: number;
  given: { storage: 'empty' };
  when: {
    operation: 'events.create';
    runId: string;
    event: {
      eventType: 'run_started';
      specVersion: number;
      eventData: {
        deploymentId: string;
        workflowName: string;
        input: FixtureBytes;
        executionContext: Record<string, unknown>;
        attributes: Record<string, string>;
        allowReservedAttributes: true;
        encryptionPublicKey: string;
      };
    };
  };
  then: {
    run: RunProjection;
    result: {
      event: EventProjection;
      preloadedSlots: number[];
      preloadedEvents: EventProjection[];
      cursorPresent: boolean;
      continuationCount: number;
      hasMore: boolean;
    };
    events: EventProjection[];
  };
};

const fixturePath = fileURLToPath(
  new URL(
    '../../../../fixtures/world-contract/v1/resilient-run-start.json',
    import.meta.url
  )
);
const fixtureSchemaPath = fileURLToPath(
  new URL(
    '../../../../fixtures/world-contract/v1/fixture.schema.json',
    import.meta.url
  )
);

function decodeBytes(value: FixtureBytes): Uint8Array {
  return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
}

function toFixtureValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(toFixtureValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, toFixtureValue(item)])
    );
  }
  return value;
}

function projectRun(run: WorkflowRun): RunProjection {
  assert(run.specVersion !== undefined);
  assert(run.input instanceof Uint8Array);
  assert(run.encryptionPublicKey !== undefined);
  return {
    runId: run.runId,
    status: run.status,
    deploymentId: run.deploymentId,
    workflowName: run.workflowName,
    specVersion: run.specVersion,
    input: toFixtureValue(run.input) as FixtureBytes,
    executionContext: toFixtureValue(run.executionContext ?? {}) as Record<
      string,
      unknown
    >,
    attributes: run.attributes ?? {},
    encryptionPublicKey: run.encryptionPublicKey,
    startedAtPresent: run.startedAt instanceof Date,
  };
}

function projectEvent(event: Event): EventProjection {
  const slot = eventIdToSlot(event.eventId);
  assert(slot !== null);
  const eventDataPresent = Object.hasOwn(event, 'eventData');
  assert(event.specVersion !== undefined);
  return {
    slot,
    eventType: event.eventType,
    specVersion: event.specVersion,
    eventDataPresent,
    ...(eventDataPresent
      ? {
          eventData: toFixtureValue(event.eventData) as Record<string, unknown>,
        }
      : {}),
  };
}

async function loadFixture(): Promise<ResilientRunStartFixture> {
  const [fixture, schema] = await Promise.all(
    [fixturePath, fixtureSchemaPath].map(async (filePath) =>
      JSON.parse(await fs.readFile(filePath, 'utf8'))
    )
  );
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(schema);
  assert(validate(fixture), ajv.errorsText(validate.errors));
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.name, 'resilient-run-start-synthesizes-created');
  assert.equal(fixture.given.storage, 'empty');
  assert.equal(fixture.when.operation, 'events.create');
  assert.equal(fixture.when.event.eventType, 'run_started');
  assert.deepEqual(fixture.requires, ['run-started-preload']);
  assert.equal(fixture.persistedSpecVersion, fixture.when.event.specVersion);
  return fixture as ResilientRunStartFixture;
}

// @lat: [[rust-portability#Verification Strategy#Contract Fixtures]]
describe('language-neutral World contract fixtures', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'world-contract-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('runs resilient-run-start-synthesizes-created', async () => {
    const fixture = await loadFixture();
    const storage = createStorage(testDir);
    const { runId, event } = fixture.when;
    const input = decodeBytes(event.eventData.input);

    const result = await storage.events.create(runId, {
      eventType: event.eventType,
      specVersion: event.specVersion,
      eventData: {
        ...event.eventData,
        input,
      },
    });

    assert(result.run);
    expect(projectRun(result.run)).toEqual(fixture.then.run);
    expect(projectEvent(result.event)).toEqual(fixture.then.result.event);
    expect(result.events?.map(({ eventId }) => eventIdToSlot(eventId))).toEqual(
      fixture.then.result.preloadedSlots
    );
    expect(result.events?.map(projectEvent)).toEqual(
      fixture.then.result.preloadedEvents
    );
    expect(typeof result.cursor === 'string').toBe(
      fixture.then.result.cursorPresent
    );
    expect(result.hasMore).toBe(fixture.then.result.hasMore);

    assert(result.cursor);
    const continuation = await storage.events.list({
      runId,
      pagination: {
        sortOrder: 'asc',
        cursor: result.cursor,
        limit: 100,
      },
    });
    expect(continuation.data).toHaveLength(
      fixture.then.result.continuationCount
    );

    const durableRun = await storage.runs.get(runId);
    const durableEvents = await storage.events.list({
      runId,
      pagination: { sortOrder: 'asc', limit: 100 },
    });

    expect(projectRun(durableRun)).toEqual(fixture.then.run);
    expect(durableEvents.data.map(projectEvent)).toEqual(fixture.then.events);
  });
});
