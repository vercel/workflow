/** Maximum rows one reader holds from a single query, whatever the stream length. */
export const STREAM_READ_PAGE_SIZE = 64;

export interface PagedStreamRow {
  id: `chnk_${string}`;
  eof: boolean;
  data: Uint8Array;
}

/** Where a reader starts: the last row before the first requested data row. */
export interface PagedStreamStart {
  /** Exclusive keyset cursor; `undefined` starts at the first row. */
  cursor: `chnk_${string}` | undefined;
  /**
   * Data rows still to skip after `cursor`, when the requested index lies
   * past the rows that exist now. EOF rows are never counted.
   */
  remainingOffset: number;
}

export interface PagedStreamSource {
  isClosed(): boolean;
  closedError(): Error;
  /** Calls `wake` whenever a row may have been appended. Returns an unsubscribe. */
  subscribe(wake: () => void): () => void;
  /** Registers `abort` to run when the owning streamer closes. Returns an unregister. */
  registerAbort(abort: () => void): () => void;
  /**
   * Resolves a non-zero `startIndex` (negative counts back from the data rows
   * before the first EOF). Must never position past the first EOF row.
   */
  prepareStart(startIndex: number): Promise<PagedStreamStart>;
  /** Rows strictly after `cursor`, ascending by id, at most `limit`. */
  loadPage(
    cursor: `chnk_${string}` | undefined,
    limit: number
  ): Promise<PagedStreamRow[]>;
}

/**
 * Reads a persisted stream in bounded, pull-paced pages. Notifications only
 * wake the reader; the keyset cursor over persisted rows is the only delivery
 * cursor, so a row seen by both a query and a notification is delivered (or
 * skipped) exactly once, and memory never holds more than one page.
 *
 * The first EOF row closes the reader; rows after it (a retried terminal
 * write) are never read.
 */
export function createPagedStream(
  source: PagedStreamSource,
  startIndex = 0
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(startIndex)) {
    throw new TypeError('Stream startIndex must be a safe integer');
  }
  if (source.isClosed()) throw source.closedError();

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cleanedUp = false;
  let initialized = false;
  let cursor: `chnk_${string}` | undefined;
  let offset = 0;
  let revision = 0;
  let wake: (() => void) | undefined;
  let unsubscribe = () => {};
  let unregisterAbort = () => {};

  // Idempotent: reachable from EOF, cancel(), a failed query and streamer
  // close(), possibly more than one for the same reader.
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    const pending = wake;
    wake = undefined;
    try {
      unsubscribe();
    } finally {
      try {
        unregisterAbort();
      } finally {
        pending?.();
      }
    }
  };
  const notify = () => {
    if (cleanedUp) return;
    revision += 1;
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  const abort = () => {
    if (cleanedUp) return;
    cleanup();
    controller.error(source.closedError());
  };

  const initialize = async () => {
    const start =
      startIndex === 0
        ? { cursor: undefined, remainingOffset: 0 }
        : await source.prepareStart(startIndex);
    if (cleanedUp) return;
    if (
      (start.cursor !== undefined && typeof start.cursor !== 'string') ||
      !Number.isSafeInteger(start.remainingOffset) ||
      start.remainingOffset < 0
    ) {
      throw new Error('Invalid stream start position');
    }
    cursor = start.cursor;
    offset = start.remainingOffset;
    initialized = true;
  };

  /** Delivers one row: skipped as offset, enqueued, or the closing EOF. */
  const deliverRow = (
    target: ReadableStreamDefaultController<Uint8Array>,
    row: PagedStreamRow
  ): 'closed' | 'emitted' | 'skipped' => {
    if (cursor !== undefined && row.id <= cursor) {
      throw new Error('Stream rows are not strictly ordered');
    }
    // Advance past skipped rows too. EOF is not a data row, so it never
    // counts toward the offset.
    cursor = row.id;
    if (offset > 0 && !row.eof) {
      offset -= 1;
      return 'skipped';
    }
    if (row.data.byteLength > 0) target.enqueue(new Uint8Array(row.data));
    if (!row.eof) return row.data.byteLength > 0 ? 'emitted' : 'skipped';
    cleanup();
    target.close();
    return 'closed';
  };

  /** Delivers one page; reports whether it enqueued data or closed the stream. */
  const deliver = (
    target: ReadableStreamDefaultController<Uint8Array>,
    rows: PagedStreamRow[]
  ): 'closed' | 'emitted' | 'nothing' => {
    if (rows.length > STREAM_READ_PAGE_SIZE) {
      throw new Error('Stream page exceeded its bound');
    }
    let emitted = false;
    for (const row of rows) {
      const outcome = deliverRow(target, row);
      if (outcome === 'closed') return outcome;
      emitted ||= outcome === 'emitted';
    }
    return emitted ? 'emitted' : 'nothing';
  };

  /** Resolves on the next wake, or at once if one arrived since `observed`. */
  const nextWake = (observed: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      if (cleanedUp || revision !== observed) {
        wake = undefined;
        resolve();
      }
    });

  /** Reads pages until one enqueues data or closes, waiting when caught up. */
  const readUntilProgress = async (
    target: ReadableStreamDefaultController<Uint8Array>
  ) => {
    while (!cleanedUp) {
      const observed = revision;
      const rows = await source.loadPage(cursor, STREAM_READ_PAGE_SIZE);
      if (cleanedUp || deliver(target, rows) !== 'nothing') return;
      if (rows.length < STREAM_READ_PAGE_SIZE && revision === observed) {
        await nextWake(observed);
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(target) {
      controller = target;
      try {
        if (source.isClosed()) throw source.closedError();
        // Subscribe before the first query: a notification racing an empty
        // page bumps `revision`, so pull() queries again instead of sleeping.
        unsubscribe = source.subscribe(notify);
        unregisterAbort = source.registerAbort(abort);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async pull(target) {
      if (cleanedUp) return;
      try {
        if (!initialized) await initialize();
        await readUntilProgress(target);
      } catch (error) {
        const alreadyClosed = cleanedUp;
        cleanup();
        // A cancel or streamer close owns the outcome of a query still in
        // flight: do not raise a second error when it settles afterwards.
        if (!alreadyClosed) throw error;
      }
    },
    cancel() {
      cleanup();
    },
  });
}
