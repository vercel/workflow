import { describe, expect, it } from 'vitest';
import { CreateEventSchema, EventSchema } from './events.js';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
  IDEMPOTENCY_KEY_TTL_MAX_MS,
  IDEMPOTENCY_KEY_TTL_MIN_MS,
  IdempotencyKeyConflictPolicySchema,
  IdempotencyKeyReusePolicySchema,
} from './index.js';
import { WorkflowRunSchema } from './runs.js';

const creationData = {
  deploymentId: 'dpl_1',
  workflowName: 'workflow//./src/orders//process',
  input: new Uint8Array([1]),
};

function runCreated(eventData: Record<string, unknown>) {
  return {
    eventType: 'run_created' as const,
    specVersion: 8,
    eventData: { ...creationData, ...eventData },
  };
}

const keyed = {
  idempotencyKey: 'order-1',
  idempotencyKeyTtlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
  idempotencyKeyReusePolicy: 'REJECT_DUPLICATE',
};

describe('idempotency key constants', () => {
  it('pins the documented bounds', () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(256);
    expect(IDEMPOTENCY_KEY_TTL_DEFAULT_MS).toBe(24 * 60 * 60 * 1000);
    expect(IDEMPOTENCY_KEY_TTL_MIN_MS).toBe(1000);
    expect(IDEMPOTENCY_KEY_TTL_MAX_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('enumerates the policies', () => {
    expect(IdempotencyKeyReusePolicySchema.options).toEqual([
      'ALLOW_DUPLICATE',
      'ALLOW_DUPLICATE_FAILED_ONLY',
      'REJECT_DUPLICATE',
    ]);
    expect(IdempotencyKeyConflictPolicySchema.options).toEqual([
      'USE_EXISTING',
      'FAIL',
    ]);
  });
});

describe('run_created idempotency fields', () => {
  it('accepts a key with its resolved TTL and reuse policy', () => {
    const parsed = CreateEventSchema.parse(runCreated(keyed));
    expect(parsed.eventData).toMatchObject(keyed);
  });

  it('accepts a key alone and no key at all', () => {
    expect(
      CreateEventSchema.safeParse(runCreated({ idempotencyKey: 'k' })).success
    ).toBe(true);
    expect(CreateEventSchema.safeParse(runCreated({})).success).toBe(true);
  });

  it('round-trips through the stored event schema', () => {
    const parsed = EventSchema.parse({
      ...runCreated(keyed),
      runId: 'wrun_00000000000000000000000000',
      eventId: 'evnt_00000000000000000000000000',
      createdAt: new Date().toISOString(),
    });
    expect(
      parsed.eventType === 'run_created' && parsed.eventData
    ).toMatchObject(keyed);
  });

  it.each([
    ['an empty key', { idempotencyKey: '' }],
    [
      'a key over the maximum length',
      { idempotencyKey: 'k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1) },
    ],
    ['a non-string key', { idempotencyKey: 42 }],
    [
      'a TTL under the minimum',
      { ...keyed, idempotencyKeyTtlMs: IDEMPOTENCY_KEY_TTL_MIN_MS - 1 },
    ],
    [
      'a TTL over the maximum',
      { ...keyed, idempotencyKeyTtlMs: IDEMPOTENCY_KEY_TTL_MAX_MS + 1 },
    ],
    ['a fractional TTL', { ...keyed, idempotencyKeyTtlMs: 1500.5 }],
    ['an unknown reuse policy', { ...keyed, idempotencyKeyReusePolicy: 'X' }],
    [
      'a TTL without a key',
      { idempotencyKeyTtlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS },
    ],
    [
      'a reuse policy without a key',
      { idempotencyKeyReusePolicy: 'ALLOW_DUPLICATE' },
    ],
  ])('rejects %s', (_label, eventData) => {
    expect(CreateEventSchema.safeParse(runCreated(eventData)).success).toBe(
      false
    );
  });

  it('accepts the TTL bounds themselves', () => {
    for (const ttl of [
      IDEMPOTENCY_KEY_TTL_MIN_MS,
      IDEMPOTENCY_KEY_TTL_MAX_MS,
    ]) {
      expect(
        CreateEventSchema.safeParse(
          runCreated({ ...keyed, idempotencyKeyTtlMs: ttl })
        ).success
      ).toBe(true);
    }
    expect(
      CreateEventSchema.safeParse(
        runCreated({ idempotencyKey: 'k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH) })
      ).success
    ).toBe(true);
  });

  it('never carries a key on run_started', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'run_started',
      specVersion: 8,
      eventData: { ...creationData, ...keyed },
    });
    expect(parsed.eventData).not.toHaveProperty('idempotencyKey');
    expect(parsed.eventData).not.toHaveProperty('idempotencyKeyTtlMs');
    expect(parsed.eventData).not.toHaveProperty('idempotencyKeyReusePolicy');
  });
});

describe('WorkflowRun idempotencyKey', () => {
  const run = {
    runId: 'wrun_1',
    status: 'running',
    deploymentId: 'dpl_1',
    workflowName: 'workflow//./src/orders//process',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('parses the echoed key', () => {
    expect(
      WorkflowRunSchema.parse({ ...run, idempotencyKey: 'order-1' })
        .idempotencyKey
    ).toBe('order-1');
  });

  it('leaves it absent on runs started without one', () => {
    expect(WorkflowRunSchema.parse(run)).not.toHaveProperty('idempotencyKey');
  });
});
