import { describe, expect, it } from 'vitest';
import { CreateEventSchema, EventSchema } from './events';

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
