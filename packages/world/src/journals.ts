import { z } from 'zod';

export const JOURNAL_ID_MAX_LENGTH = 512;
export const JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH = 512;
export const JOURNAL_REVISION_MAX_LENGTH = 128;

export const JournalIdSchema = z.string().min(1).max(JOURNAL_ID_MAX_LENGTH);
export const JournalIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(JOURNAL_IDEMPOTENCY_KEY_MAX_LENGTH);
export const JournalRevisionSchema = z
  .string()
  .min(1)
  .max(JOURNAL_REVISION_MAX_LENGTH);

/** The latest opaque state committed to a durable journal. */
export const JournalStateSchema = z.object({
  journalId: JournalIdSchema,
  revision: JournalRevisionSchema,
  state: z.instanceof(Uint8Array),
});

export type JournalState = z.infer<typeof JournalStateSchema>;

export const JournalCommitOptionsSchema = z.object({
  expectedRevision: JournalRevisionSchema.nullable(),
  idempotencyKey: JournalIdempotencyKeySchema,
});

export type JournalCommitOptions = z.infer<typeof JournalCommitOptionsSchema>;

/**
 * Durable opaque state whose lifetime is independent of any workflow run.
 *
 * Revisions are opaque compare-and-set tokens. A successful commit must be
 * immediately visible to later reads. Implementations must check idempotency
 * before `expectedRevision`: retrying the same key and bytes returns the
 * original commit, even if the journal has advanced. Reusing a key with
 * different bytes or committing against a stale revision throws
 * `EntityConflictError`. Persistence follows the durability guarantees of the
 * implementing World.
 */
export interface Journals {
  /** Returns the latest committed state, or `null` when no state exists. */
  get(journalId: string): Promise<JournalState | null>;

  /**
   * Atomically commits a complete state value and advances the revision.
   * `expectedRevision: null` creates the journal only when it does not exist.
   */
  commit(
    journalId: string,
    state: Uint8Array,
    options: JournalCommitOptions
  ): Promise<JournalState>;
}
