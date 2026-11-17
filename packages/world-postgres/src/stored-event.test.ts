import { describe, expect, it } from 'vitest';
import type { Schema } from './drizzle/index.js';
import { parseStoredEvent } from './stored-event.js';

type EventRow = typeof Schema.events.$inferSelect;

const createdAt = new Date('2026-01-02T03:04:05.000Z');

function row(fields: Partial<EventRow> & Pick<EventRow, 'eventType'>) {
  return {
    eventId: 'evnt_0000000000000000000000001',
    correlationId: null,
    createdAt,
    runId: 'wrun_01',
    eventDataJson: null,
    eventData: null,
    specVersion: 9,
    resumeId: null,
    resumePayloadDigest: null,
    ...fields,
  } satisfies EventRow;
}

describe('parseStoredEvent', () => {
  it('returns an event with its data', () => {
    const event = parseStoredEvent(
      row({
        eventType: 'step_created',
        correlationId: 'step_01',
        eventData: { stepName: 'a-step', input: new Uint8Array([1]) },
      })
    );
    expect(event).toMatchObject({
      eventType: 'step_created',
      correlationId: 'step_01',
      eventData: { stepName: 'a-step', input: new Uint8Array([1]) },
    });
  });

  it('reads the legacy JSON column when the CBOR one is empty', () => {
    const event = parseStoredEvent(
      row({
        eventType: 'step_created',
        correlationId: 'step_01',
        eventDataJson: { stepName: 'a-step', input: ['legacy'] },
      })
    );
    expect(event).toMatchObject({
      eventData: { stepName: 'a-step', input: ['legacy'] },
    });
  });

  // Every one of these requires an `eventData` object when it is written.
  const purged = [
    ['run_created', undefined],
    ['run_completed', undefined],
    ['run_failed', undefined],
    ['step_created', 'step_01'],
    ['step_completed', 'step_01'],
    ['hook_created', 'hook_01'],
    ['hook_received', 'hook_01'],
    ['wait_created', 'wait_01'],
  ] as const;

  for (const [eventType, correlationId] of purged) {
    it(`returns a ${eventType} whose data a purge deleted, without eventData`, () => {
      const event = parseStoredEvent(
        row({ eventType, correlationId: correlationId ?? null })
      );
      expect(event).toEqual({
        eventType,
        ...(correlationId ? { correlationId } : {}),
        runId: 'wrun_01',
        eventId: 'evnt_0000000000000000000000001',
        createdAt,
        specVersion: 9,
      });
    });
  }

  it('keeps the resume id of a purged hook_received', () => {
    const event = parseStoredEvent(
      row({
        eventType: 'hook_received',
        correlationId: 'hook_01',
        resumeId: 'resume-1',
      })
    );
    expect(event).toMatchObject({ resumeId: 'resume-1' });
    expect(event).not.toHaveProperty('resumePayloadDigest');
  });

  it('still rejects an event whose data is there and does not parse', () => {
    expect(() =>
      parseStoredEvent(
        row({ eventType: 'run_created', eventData: { workflowName: 'w' } })
      )
    ).toThrow();
  });

  it('still rejects an event of an unknown type', () => {
    expect(() =>
      parseStoredEvent(row({ eventType: 'not_an_event' as never }))
    ).toThrow();
  });
});
