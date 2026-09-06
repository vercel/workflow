import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

type LeasedQueueFixture = {
  fixtureVersion: 1;
  name: 'leased-queue-recovers-and-reconciles';
  requires: ['leased-queue', 'active-run-reconciliation'];
  persistedSpecVersion: number;
  given: {
    activeRun: {
      runId: string;
      deploymentId: string;
      workflowName: string;
      input: FixtureBytes;
    };
  };
  when: {
    scope: string;
    deploymentId: string;
    queuePrefix: string;
    queueName: string;
    leaseDurationMs: number;
    operations: Array<
      | { operation: 'reconcile'; atMs: number; expect: unknown }
      | { operation: 'claim'; workerId: string; atMs: number; expect: unknown }
      | {
          operation: 'reschedule';
          atMs: number;
          availableAtMs: number;
          expect: unknown;
        }
      | { operation: 'acknowledge'; atMs: number; expect: unknown }
    >;
  };
  then: {
    queuedMessageCount: number;
    messageIds: string[];
  };
};

type ReferenceQueueMessage = {
  messageId: string;
  scope: string;
  queueName: string;
  body: Uint8Array;
  availableAtMs: number;
  attempt: number;
  leaseToken?: string;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
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
const leasedQueueFixturePath = fileURLToPath(
  new URL(
    '../../../../fixtures/world-contract/v1/leased-queue.json',
    import.meta.url
  )
);
const leasedQueueSchemaPath = fileURLToPath(
  new URL(
    '../../../../fixtures/world-contract/v1/leased-queue.schema.json',
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

async function loadAndValidateFixture(
  dataPath: string,
  schemaPath: string
): Promise<unknown> {
  const [fixture, schema] = await Promise.all(
    [dataPath, schemaPath].map(async (filePath) =>
      JSON.parse(await fs.readFile(filePath, 'utf8'))
    )
  );
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(schema);
  assert(validate(fixture), ajv.errorsText(validate.errors));
  return fixture;
}

async function loadFixture(): Promise<ResilientRunStartFixture> {
  const fixture = (await loadAndValidateFixture(
    fixturePath,
    fixtureSchemaPath
  )) as ResilientRunStartFixture;
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.name, 'resilient-run-start-synthesizes-created');
  assert.equal(fixture.given.storage, 'empty');
  assert.equal(fixture.when.operation, 'events.create');
  assert.equal(fixture.when.event.eventType, 'run_started');
  assert.deepEqual(fixture.requires, ['run-started-preload']);
  assert.equal(fixture.persistedSpecVersion, fixture.when.event.specVersion);
  return fixture;
}

async function loadLeasedQueueFixture(): Promise<LeasedQueueFixture> {
  const fixture = (await loadAndValidateFixture(
    leasedQueueFixturePath,
    leasedQueueSchemaPath
  )) as LeasedQueueFixture;
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.name, 'leased-queue-recovers-and-reconciles');
  assert.deepEqual(fixture.requires, [
    'leased-queue',
    'active-run-reconciliation',
  ]);
  return fixture;
}

class LeasedQueueReferenceModel {
  readonly #messages = new Map<string, ReferenceQueueMessage>();

  constructor(
    private readonly activeRun: LeasedQueueFixture['given']['activeRun']
  ) {}

  reconcile(
    scope: string,
    deploymentId: string,
    queuePrefix: string,
    atMs: number
  ) {
    assert.equal(this.activeRun.deploymentId, deploymentId);
    const messageId = this.activeRunMessageId(scope);
    let createdMessageCount = 0;
    if (!this.#messages.has(messageId)) {
      this.#messages.set(messageId, {
        messageId,
        scope,
        queueName: `${queuePrefix}${this.activeRun.workflowName}`,
        body: new TextEncoder().encode(
          JSON.stringify({ runId: this.activeRun.runId })
        ),
        availableAtMs: atMs,
        attempt: 0,
      });
      createdMessageCount = 1;
    }
    return {
      activeRunCount: 1,
      createdMessageCount,
      messageIds: [messageId],
      queuedMessageCount: this.#messages.size,
    };
  }

  claim(
    scope: string,
    queueName: string,
    workerId: string,
    atMs: number,
    leaseDurationMs: number
  ) {
    const message = [...this.#messages.values()]
      .filter(
        (candidate) =>
          candidate.scope === scope &&
          candidate.queueName === queueName &&
          candidate.availableAtMs <= atMs &&
          (candidate.leaseExpiresAtMs === undefined ||
            candidate.leaseExpiresAtMs <= atMs)
      )
      .sort((left, right) => left.messageId.localeCompare(right.messageId))[0];
    if (!message) return null;
    message.attempt++;
    message.leaseOwner = workerId;
    message.leaseExpiresAtMs = atMs + leaseDurationMs;
    message.leaseToken = `${message.messageId}:${message.attempt}:${workerId}`;
    return {
      messageId: message.messageId,
      attempt: message.attempt,
      leaseOwner: message.leaseOwner,
      leaseExpiresAtMs: message.leaseExpiresAtMs,
      body: toFixtureValue(message.body),
    };
  }

  reschedule(leaseToken: string, atMs: number, availableAtMs: number) {
    const message = this.messageForLease(leaseToken);
    assert(
      message.leaseExpiresAtMs !== undefined && message.leaseExpiresAtMs > atMs,
      'only a live lease may reschedule a message'
    );
    message.availableAtMs = availableAtMs;
    delete message.leaseToken;
    delete message.leaseOwner;
    delete message.leaseExpiresAtMs;
    return {
      messageId: message.messageId,
      queuedMessageCount: this.#messages.size,
    };
  }

  acknowledge(leaseToken: string, atMs: number) {
    const message = this.messageForLease(leaseToken);
    assert(
      message.leaseExpiresAtMs !== undefined && message.leaseExpiresAtMs > atMs,
      'only a live lease may acknowledge a message'
    );
    this.#messages.delete(message.messageId);
    return {
      messageId: message.messageId,
      queuedMessageCount: this.#messages.size,
    };
  }

  get messageIds(): string[] {
    return [...this.#messages.keys()].sort();
  }

  get size(): number {
    return this.#messages.size;
  }

  currentLeaseToken(): string {
    const claimed = [...this.#messages.values()].find(
      ({ leaseToken }) => leaseToken !== undefined
    );
    assert(claimed?.leaseToken);
    return claimed.leaseToken;
  }

  private activeRunMessageId(scope: string): string {
    const digest = createHash('sha256')
      .update('workflow-active-run\0')
      .update(scope)
      .update('\0')
      .update(this.activeRun.runId)
      .digest('hex');
    return `msg_reconcile_${digest}`;
  }

  private messageForLease(leaseToken: string): ReferenceQueueMessage {
    const message = [...this.#messages.values()].find(
      (candidate) => candidate.leaseToken === leaseToken
    );
    assert(message, 'queue lease must still identify a message');
    return message;
  }
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

  it('runs leased-queue-recovers-and-reconciles', async () => {
    const fixture = await loadLeasedQueueFixture();
    const model = new LeasedQueueReferenceModel(fixture.given.activeRun);

    for (const operation of fixture.when.operations) {
      let actual: unknown;
      switch (operation.operation) {
        case 'reconcile':
          actual = model.reconcile(
            fixture.when.scope,
            fixture.when.deploymentId,
            fixture.when.queuePrefix,
            operation.atMs
          );
          break;
        case 'claim':
          actual = model.claim(
            fixture.when.scope,
            fixture.when.queueName,
            operation.workerId,
            operation.atMs,
            fixture.when.leaseDurationMs
          );
          break;
        case 'reschedule':
          actual = model.reschedule(
            model.currentLeaseToken(),
            operation.atMs,
            operation.availableAtMs
          );
          break;
        case 'acknowledge':
          actual = model.acknowledge(model.currentLeaseToken(), operation.atMs);
          break;
      }
      expect(actual).toEqual(operation.expect);
    }

    expect(model.size).toBe(fixture.then.queuedMessageCount);
    expect(model.messageIds).toEqual(fixture.then.messageIds);
  });
});
