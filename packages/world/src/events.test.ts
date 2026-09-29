import { describe, expect, it } from 'vitest';
import { CreateEventSchema, EventSchema } from './events';

describe('dynamic workflow code storage shape', () => {
  const inline = new Uint8Array([1, 2, 3]);
  const creationData = {
    deploymentId: 'dpl_1',
    workflowName: 'workflow//dynamic/test//workflow',
    input: new Uint8Array([4]),
  };

  for (const eventType of ['run_created', 'run_started'] as const) {
    const base = {
      eventType,
      specVersion: 5,
      eventData: eventType === 'run_created' ? creationData : {},
    };

    it(`${eventType} accepts neither, inline only, or ref only`, () => {
      expect(CreateEventSchema.safeParse(base).success).toBe(true);
      expect(
        CreateEventSchema.safeParse({
          ...base,
          eventData: { ...base.eventData, dynamicWorkflowCode: inline },
        }).success
      ).toBe(true);
      expect(
        CreateEventSchema.safeParse({
          ...base,
          eventData: { ...base.eventData, dynamicWorkflowCodeRef: 'ref_1' },
        }).success
      ).toBe(true);
    });

    it(`${eventType} rejects inline code and a ref together in request and stored schemas`, () => {
      const eventData = {
        ...base.eventData,
        dynamicWorkflowCode: inline,
        dynamicWorkflowCodeRef: 'ref_1',
      };
      expect(CreateEventSchema.safeParse({ ...base, eventData }).success).toBe(
        false
      );
      expect(
        EventSchema.safeParse({
          ...base,
          eventData,
          runId: 'wrun_00000000000000000000000000',
          eventId: 'evnt_00000000000000000000000000',
          createdAt: new Date().toISOString(),
        }).success
      ).toBe(false);
    });
  }
});

describe('hook_created token retention', () => {
  it('coerces tokenRetentionUntil to a Date', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'hook_created',
      correlationId: 'hook_1',
      specVersion: 5,
      eventData: {
        token: 'order:123',
        tokenRetentionUntil: '2026-08-01T00:00:00.000Z',
      },
    });

    expect(parsed.eventType).toBe('hook_created');
    if (parsed.eventType === 'hook_created') {
      expect(parsed.eventData.tokenRetentionUntil).toEqual(
        new Date('2026-08-01T00:00:00.000Z')
      );
    }
  });
});

describe('step_started ownerMessageId', () => {
  it('accepts a bare step_started with no eventData (legacy contract)', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'step_started',
      specVersion: 4,
      correlationId: 'step_00000000000000000000000000',
    });
    expect(parsed.eventType).toBe('step_started');
  });

  it('accepts an optional ownerMessageId on the create request', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'step_started',
      specVersion: 4,
      correlationId: 'step_00000000000000000000000000',
      eventData: { stepName: 'step//file//fn', ownerMessageId: 'msg_abc123' },
    });
    expect(
      (parsed as { eventData?: { ownerMessageId?: string } }).eventData
        ?.ownerMessageId
    ).toBe('msg_abc123');
  });

  it('retains ownerMessageId when reading back a stored step_started event (not stripped)', () => {
    const parsed = EventSchema.parse({
      eventType: 'step_started',
      runId: 'wrun_00000000000000000000000000',
      eventId: 'evnt_00000000000000000000000000',
      correlationId: 'step_00000000000000000000000000',
      createdAt: new Date().toISOString(),
      specVersion: 4,
      eventData: { stepName: 'step//file//fn', ownerMessageId: 'msg_abc123' },
    });
    expect(
      (parsed as { eventData?: { ownerMessageId?: string } }).eventData
        ?.ownerMessageId
    ).toBe('msg_abc123');
  });
});

describe('run_cancelled cancelReason', () => {
  it('accepts a run_cancelled create request with no eventData', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'run_cancelled',
      specVersion: 4,
    });
    expect(parsed.eventType).toBe('run_cancelled');
  });

  it('accepts an optional cancelReason on the create request', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'run_cancelled',
      specVersion: 4,
      eventData: { cancelReason: 'superseded by newer run' },
    });
    expect(parsed.eventType).toBe('run_cancelled');
    // eventData is only present on the run_cancelled branch of the union.
    expect(
      (parsed as { eventData?: { cancelReason?: string } }).eventData
        ?.cancelReason
    ).toBe('superseded by newer run');
  });

  it('rejects a cancelReason longer than 512 chars', () => {
    const result = CreateEventSchema.safeParse({
      eventType: 'run_cancelled',
      specVersion: 4,
      eventData: { cancelReason: 'x'.repeat(513) },
    });
    expect(result.success).toBe(false);
  });

  it('retains cancelReason when reading back a stored run_cancelled event (not stripped)', () => {
    const parsed = EventSchema.parse({
      eventType: 'run_cancelled',
      runId: 'wrun_00000000000000000000000000',
      eventId: 'evnt_00000000000000000000000000',
      createdAt: new Date().toISOString(),
      specVersion: 4,
      eventData: { cancelReason: 'operator cancelled' },
    });
    expect(
      (parsed as { eventData?: { cancelReason?: string } }).eventData
        ?.cancelReason
    ).toBe('operator cancelled');
  });
});

describe('sealed-log noop events', () => {
  it('parses a noop event from the read union', () => {
    // Written only by the World's backend when it seals an abandoned slot
    // (specVersion >= 7); readers must accept it wherever events are parsed.
    const parsed = EventSchema.parse({
      eventType: 'noop',
      runId: 'wrun_123',
      eventId: 'evnt_00000000000000000000000003',
      createdAt: new Date().toISOString(),
      specVersion: 7,
      eventData: { sealed: true },
    });
    expect(parsed.eventType).toBe('noop');
  });

  it('parses a noop with no eventData at all', () => {
    const parsed = EventSchema.parse({
      eventType: 'noop',
      runId: 'wrun_123',
      eventId: 'evnt_00000000000000000000000003',
      createdAt: new Date().toISOString(),
    });
    expect(parsed.eventType).toBe('noop');
  });

  it('is not user-creatable', () => {
    // A client-minted noop would burn a slot it never allocated; only the
    // backend's sealer writes them.
    const result = CreateEventSchema.safeParse({
      eventType: 'noop',
      eventData: { sealed: true },
    });
    expect(result.success).toBe(false);
  });
});
