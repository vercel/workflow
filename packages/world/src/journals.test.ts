import { describe, expect, it } from 'vitest';
import {
  JOURNAL_ID_MAX_LENGTH,
  JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  JOURNAL_REVISION_MAX_LENGTH,
  JournalCommitOptionsSchema,
  JournalIdSchema,
  JournalRevisionSchema,
  JournalStateSchema,
} from './journals.js';

describe('journal schemas', () => {
  it('preserves opaque bytes', () => {
    const state = new Uint8Array([0, 1, 255]);

    const parsed = JournalStateSchema.parse({
      journalId: 'session:123',
      revision: 'revision-1',
      state,
    });

    expect(parsed.state).toBe(state);
  });

  it('requires bounded identifiers and an explicit creation revision', () => {
    expect(() => JournalIdSchema.parse('')).toThrow();
    expect(() =>
      JournalIdSchema.parse('x'.repeat(JOURNAL_ID_MAX_LENGTH + 1))
    ).toThrow();
    expect(() => JournalRevisionSchema.parse('')).toThrow();
    expect(() =>
      JournalRevisionSchema.parse('x'.repeat(JOURNAL_REVISION_MAX_LENGTH + 1))
    ).toThrow();
    expect(() =>
      JournalCommitOptionsSchema.parse({
        expectedRevision: null,
        idempotencyKey: '',
      })
    ).toThrow();
    expect(() =>
      JournalCommitOptionsSchema.parse({ idempotencyKey: 'create-session' })
    ).toThrow();
    expect(() =>
      JournalCommitOptionsSchema.parse({
        expectedRevision: null,
        idempotencyKey: 'x'.repeat(JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      })
    ).toThrow();
    expect(
      JournalCommitOptionsSchema.parse({
        expectedRevision: null,
        idempotencyKey: 'create-session',
      })
    ).toEqual({ expectedRevision: null, idempotencyKey: 'create-session' });
    expect(
      JournalIdSchema.parse('x'.repeat(JOURNAL_ID_MAX_LENGTH))
    ).toHaveLength(JOURNAL_ID_MAX_LENGTH);
    expect(
      JournalRevisionSchema.parse('x'.repeat(JOURNAL_REVISION_MAX_LENGTH))
    ).toHaveLength(JOURNAL_REVISION_MAX_LENGTH);
    expect(
      JournalCommitOptionsSchema.parse({
        expectedRevision: null,
        idempotencyKey: 'x'.repeat(JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH),
      }).idempotencyKey
    ).toHaveLength(JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH);
  });
});
