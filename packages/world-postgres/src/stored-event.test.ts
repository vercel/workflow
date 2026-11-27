import { describe, expect, it } from 'vitest';
import type { Schema } from './drizzle/index.js';
import { parseStoredEvent, parseStoredEvents } from './stored-event.js';

type EventRow = typeof Schema.events.$inferSelect;

/** The fields every stored event has, whatever its type. */
const identity = {
  runId: 'wrun_01',
  eventId: 'evnt_0000000000000000000000001',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  specVersion: 9,
};

function row(fields: Partial<EventRow> & Pick<EventRow, 'eventType'>) {
  return {
    ...identity,
    correlationId: null,
    eventDataJson: null,
    eventData: null,
    resumeId: null,
    resumePayloadDigest: null,
    ...fields,
  } satisfies EventRow;
}

/**
 * Stands in for the database: the runs-table read returns `expiredRunIds` as
 * the runs whose data was deleted, and `reads` counts how often it ran.
 */
function fakeDb(expiredRunIds: string[] = [identity.runId]) {
  const db = {
    reads: 0,
    select: () => ({
      from: () => ({
        where: async () => {
          db.reads++;
          return expiredRunIds.map((id) => ({ id }));
        },
      }),
    }),
  };
  return db as typeof db & Parameters<typeof parseStoredEvent>[0];
}

describe('parseStoredEvent', () => {
  it('returns an event with its data', async () => {
    const event = await parseStoredEvent(
      fakeDb(),
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

  it('reads the legacy JSON column when the CBOR one is empty', async () => {
    const event = await parseStoredEvent(
      fakeDb(),
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
    it(`returns a ${eventType} whose data a purge deleted, without eventData`, async () => {
      const event = await parseStoredEvent(
        fakeDb(),
        row({ eventType, correlationId: correlationId ?? null })
      );
      expect(event).toEqual({
        ...identity,
        eventType,
        ...(correlationId ? { correlationId } : {}),
      });
    });
  }

  it('keeps the resume id of a purged hook_received', async () => {
    const event = await parseStoredEvent(
      fakeDb(),
      row({
        eventType: 'hook_received',
        correlationId: 'hook_01',
        resumeId: 'resume-1',
      })
    );
    expect(event).toMatchObject({ resumeId: 'resume-1' });
    expect(event).not.toHaveProperty('resumePayloadDigest');
  });

  it('still rejects an event whose data is there and does not parse', async () => {
    await expect(
      parseStoredEvent(
        fakeDb(),
        row({ eventType: 'run_created', eventData: { workflowName: 'w' } })
      )
    ).rejects.toThrow();
  });

  it('still rejects an event of an unknown type', async () => {
    await expect(
      parseStoredEvent(fakeDb(), row({ eventType: 'not_an_event' as never }))
    ).rejects.toThrow();
  });

  it('rejects an event without its data when the run still has its data', async () => {
    await expect(
      parseStoredEvent(
        fakeDb([]),
        row({ eventType: 'step_created', correlationId: 'step_01' })
      )
    ).rejects.toThrow();
  });

  it('reads the runs table once per batch, and not at all when every event has its data', async () => {
    const withData = row({
      eventType: 'step_created',
      correlationId: 'step_01',
      eventData: { stepName: 'a-step', input: new Uint8Array([1]) },
    });
    const db = fakeDb();
    await parseStoredEvents(db, [withData, withData]);
    expect(db.reads).toBe(0);

    const dataless = row({
      eventType: 'step_created',
      correlationId: 'step_01',
    });
    const events = await parseStoredEvents(db, [withData, dataless, dataless]);
    expect(db.reads).toBe(1);
    expect(events.map((e) => 'eventData' in e)).toEqual([true, false, false]);
  });
});
