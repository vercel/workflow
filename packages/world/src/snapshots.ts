import { z } from 'zod';

export const SnapshotMetadataSchema = z.object({
  /**
   * Pagination cursor for events.list() — the snapshot was taken at
   * this point in the event log. On restore, only events AFTER this
   * cursor need to be fetched.
   */
  eventsCursor: z.string().nullable(),
  /** Timestamp when the snapshot was created */
  createdAt: z.coerce.date(),
});

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;
