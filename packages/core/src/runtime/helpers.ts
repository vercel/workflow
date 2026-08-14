import {
  PreconditionFailedError,
  RUN_ERROR_CODES,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  EventStreamObserver,
  HealthCheckPayload,
  ValidQueueName,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  FIRST_EVENT_SLOT,
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  HOOK_RESUME_INPUT_VERSION,
  requireEventSlot,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { runtimeLogger } from '../logger.js';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import {
  type DecryptionKey,
  deriveRunPayloadKeys,
} from '../serialization/encryption.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanKind, trace } from '../telemetry.js';
import { version as workflowCoreVersion } from '../version.js';
import { getWorldLazy } from './get-world-lazy.js';

/** Default timeout for health checks in milliseconds */
const DEFAULT_HEALTH_CHECK_TIMEOUT = 30_000;

/**
 * Pattern for safe workflow names. Only allows alphanumeric characters,
 * underscores, hyphens, dots, forward slashes (for namespaced workflows),
 * and at signs (for scoped packages).
 */
const SAFE_WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9_\-./@]+$/;

/**
 * Validates a workflow name and returns the corresponding queue name.
 * Ensures the workflow name only contains safe characters before
 * interpolating it into the queue name string.
 */
export function getWorkflowQueueName(
  workflowName: string,
  namespace?: string
): ValidQueueName {
  if (!SAFE_WORKFLOW_NAME_PATTERN.test(workflowName)) {
    throw new Error(
      `Invalid workflow name "${workflowName}": must only contain alphanumeric characters, underscores, hyphens, dots, forward slashes, or at signs`
    );
  }
  const prefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(namespace)
  );
  return `${prefix}${workflowName}` as ValidQueueName;
}

const generateId = monotonicFactory();

/**
 * Returns the stream name for a health check with the given correlation ID.
 */
function getHealthCheckStreamName(correlationId: string): string {
  return `__health_check__${correlationId}`;
}

/**
 * Result of a health check operation.
 */
export interface HealthCheckResult {
  healthy: boolean;
  /** Error message if health check failed */
  error?: string;
  /** Latency if the health check was successful */
  latencyMs?: number;
  /** Spec version of the responding deployment */
  specVersion?: number;
  /**
   * `@workflow/core` version of the responding deployment, used for
   * capability detection (see `getRunCapabilities`). Omitted when the
   * responding deployment did not provide the field as a string —
   * for example, an older `@workflow/core` that predates this field,
   * or a non-JSON plain-text health response.
   */
  workflowCoreVersion?: string;
  /**
   * The target run's X25519 public key (base64), returned only when the probe
   * carried a `runId` and the responding deployment has encryption enabled.
   *
   * Lets a cross-deployment `start()` seal the workflow arguments using a
   * response it was already waiting on, instead of making a separate
   * key-lookup request.
   */
  encryptionPublicKey?: string;
  /**
   * The responding deployment's `HOOK_RESUME_INPUT_VERSION` — the protocol
   * version at which the *consumer* (queue-message target) re-ensures the
   * `hook_received` event from `hookInput` on replay. A cross-deployment
   * `start()` stamps the *target's* value (not the caller's) into the new
   * run's `executionContext.hookResumeInputVersion` so that `resumeHook()`
   * only takes the parallel path when the deployment that will actually
   * consume the queue message is known to honor `hookInput`. Omitted when the
   * responding deployment predates this field (an older consumer that ignores
   * `hookInput`), which fails the gate closed.
   */
  hookResumeInputVersion?: number;
}

/**
 * Checks if the given message is a health check payload.
 * If so, returns the parsed payload. Otherwise returns undefined.
 */
export function parseHealthCheckPayload(
  message: unknown
): HealthCheckPayload | undefined {
  const result = HealthCheckPayloadSchema.safeParse(message);
  if (result.success) {
    return result.data;
  }
  return undefined;
}

/**
 * Generates a deterministic fake runId for health check streams.
 * Both the writer (handleHealthCheckMessage) and reader (healthCheck) derive
 * the same runId from the correlationId so that implementations that scope
 * stream reads by runId still work correctly.
 */
function generateHealthCheckRunId(correlationId: string): string {
  return `wrun_hc_${correlationId}`;
}

/**
 * Handles a health check message by writing the result to the world's stream.
 * The caller can listen to this stream to get the health check response.
 *
 * @param healthCheck - The parsed health check payload
 */
export async function handleHealthCheckMessage(
  healthCheck: HealthCheckPayload,
  worldSpecVersion?: number
): Promise<void> {
  const world = await getWorldLazy();
  const streamName = getHealthCheckStreamName(healthCheck.correlationId);

  // When the probe names a run the caller is about to create, publish that
  // run's public key. We are executing inside the target deployment, so its
  // key material is available locally (no API call), and the caller can then
  // seal the workflow arguments straight from this response rather than
  // making a separate key-lookup request.
  //
  // Only a *public* key may travel this way: the probe response stream is
  // deliberately unauthenticated, so anything secret would be exposed.
  // Best-effort — a failure here must not fail the health check itself, which
  // callers also rely on for plain capability detection.
  let encryptionPublicKey: string | undefined;
  if (healthCheck.runId) {
    try {
      const rawKey = await world.getEncryptionKeyForRun?.(healthCheck.runId);
      if (rawKey) {
        encryptionPublicKey = bytesToBase64(
          (await deriveRunKeyPair(rawKey)).publicKey
        );
      }
    } catch (err) {
      runtimeLogger.warn(
        'Health check could not derive a run public key; the caller will fall back to a key lookup',
        {
          correlationId: healthCheck.correlationId,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }

  const response = JSON.stringify({
    healthy: true,
    correlationId: healthCheck.correlationId,
    specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT,
    workflowCoreVersion,
    // We are executing inside the target deployment, so this constant reflects
    // the *consumer's* hook-resume protocol version — exactly what a
    // cross-deployment caller needs to gate its parallel resume path on.
    hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
    ...(encryptionPublicKey ? { encryptionPublicKey } : {}),
    timestamp: Date.now(),
  });
  // Use a deterministic fake runId derived from the correlationId so that
  // the reader side produces the same value.
  const fakeRunId = generateHealthCheckRunId(healthCheck.correlationId);
  await world.streams.write(fakeRunId, streamName, response);
  await world.streams.close(fakeRunId, streamName);
}

export interface HealthCheckOptions {
  /** Timeout in milliseconds to wait for health check response. Default: 30000 (30s) */
  timeout?: number;
  /** Deployment ID to send the health check to. Falls back to process.env.VERCEL_DEPLOYMENT_ID. */
  deploymentId?: string;
  /**
   * The run id the caller is about to create. When set, the responding
   * deployment derives that run's public key locally and returns it as
   * `encryptionPublicKey`, letting a cross-deployment `start()` seal the
   * workflow arguments without a separate key lookup.
   */
  runId?: string;
  /**
   * Queue namespace of the target deployment (e.g. `'eve'` for topics like
   * `__eve_wkf_workflow_*`). Falls back to `WORKFLOW_QUEUE_NAMESPACE` in the
   * calling process. Cross-context callers (e.g. the observability
   * dashboard) must pass the target deployment's namespace explicitly —
   * the env fallback resolves in the caller's process, and a message
   * published to a mismatched topic has no consumer, so the check would
   * always time out.
   */
  namespace?: string;
}

/**
 * Performs a health check by sending a message through the queue pipeline
 * and verifying it is processed by the combined workflow endpoint.
 *
 * This function bypasses Deployment Protection on Vercel because it goes
 * through the queue infrastructure rather than direct HTTP.
 *
 * @param world - The World instance to use for the health check
 * @param options - Optional configuration for the health check
 * @returns Promise resolving to health check result
 */
// Poll interval for health check retries (ms)
const HEALTH_CHECK_POLL_INTERVAL = 100;
// Per-read timeout to prevent blocking forever on local world's EventEmitter
// (which doesn't work across processes)
const HEALTH_CHECK_READ_TIMEOUT = 500;

/**
 * Read chunks from a stream with a timeout per read operation.
 * Returns { chunks, timedOut } where timedOut indicates if a read timed out.
 */
/**
 * Race a promise against a deadline. Rejects with a timeout error when the
 * deadline elapses first. Used to bound `world.streams.get()` inside the
 * health-check poll loop: some worlds hold that request open until the
 * stream has data (e.g. workflow-server holds unwritten streams open for
 * ~2 minutes), which would otherwise blow through the configured health
 * check timeout — the `while` condition is only re-checked between
 * iterations.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Operation timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readStreamWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readTimeout: number
): Promise<{ chunks: Uint8Array[]; timedOut: boolean }> {
  const chunks: Uint8Array[] = [];
  let done = false;
  let timedOut = false;

  while (!done && !timedOut) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve({ done: true, value: undefined });
        }, readTimeout)
    );

    const result = await Promise.race([readPromise, timeoutPromise]);
    done = result.done;
    if (result.value) chunks.push(result.value);
  }

  return { chunks, timedOut };
}

/**
 * Parse and validate a health check response from stream chunks.
 * Returns the parsed response or null if invalid.
 */
function parseHealthCheckResponse(chunks: Uint8Array[]): {
  healthy: boolean;
  specVersion?: number;
  workflowCoreVersion?: string;
  encryptionPublicKey?: string;
} | null {
  if (chunks.length === 0) return null;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const responseText = new TextDecoder().decode(combined);

  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    // Old deployments (specVersion < 3) return plain text like
    // 'Workflow SDK "..." endpoint is healthy'. Treat any non-empty
    // text response as a healthy deployment with unknown specVersion.
    if (responseText.length > 0) {
      return { healthy: true };
    }
    return null;
  }

  if (
    typeof response !== 'object' ||
    response === null ||
    !('healthy' in response) ||
    typeof (response as { healthy: unknown }).healthy !== 'boolean'
  ) {
    return null;
  }

  const r = response as Record<string, unknown>;
  const parsed: {
    healthy: boolean;
    specVersion?: number;
    workflowCoreVersion?: string;
    encryptionPublicKey?: string;
    hookResumeInputVersion?: number;
  } = {
    healthy: r.healthy as boolean,
  };
  if (typeof r.specVersion === 'number') {
    parsed.specVersion = r.specVersion;
  }
  if (typeof r.workflowCoreVersion === 'string') {
    parsed.workflowCoreVersion = r.workflowCoreVersion;
  }
  if (typeof r.encryptionPublicKey === 'string') {
    parsed.encryptionPublicKey = r.encryptionPublicKey;
  }
  if (typeof r.hookResumeInputVersion === 'number') {
    parsed.hookResumeInputVersion = r.hookResumeInputVersion;
  }
  return parsed;
}

export async function healthCheck(
  world: World,
  options?: HealthCheckOptions
): Promise<HealthCheckResult> {
  const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
  // Use the world's ID generator when available so the correlationId is a
  // region-tagged ULID. The health-check response is delivered over a stream
  // whose name embeds this correlationId; under platform-directed routing the
  // reader and the responding endpoint can be served from different physical
  // regions, so the region must be encoded in the ID itself for both sides to
  // resolve the same (region-pinned) backend. Falls back to a plain ULID for
  // worlds that don't tag IDs (e.g. local), which resolve to the default
  // region on both sides.
  const correlationId = world.createRunId?.() ?? generateId();
  const streamName = getHealthCheckStreamName(correlationId);

  const queueName =
    `${getQueueTopicPrefix('workflow', resolveQueueNamespace(options?.namespace))}health_check` as ValidQueueName;

  const startTime = Date.now();

  try {
    await world.queue(
      queueName,
      {
        __healthCheck: true,
        correlationId,
        ...(options?.runId ? { runId: options.runId } : {}),
      },
      {
        // Use JSON transport so the health check works against both
        // old (JSON-only) and new (dual) deployments.
        specVersion: SPEC_VERSION_LEGACY,
        deploymentId: options?.deploymentId,
      }
    );

    while (Date.now() - startTime < timeout) {
      try {
        const remainingMs = timeout - (Date.now() - startTime);
        const stream = await withDeadline(
          world.streams.get(
            generateHealthCheckRunId(correlationId),
            streamName
          ),
          remainingMs
        );
        const reader = stream.getReader();
        const { chunks, timedOut } = await readStreamWithTimeout(
          reader,
          HEALTH_CHECK_READ_TIMEOUT
        );

        if (timedOut) {
          try {
            reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          await new Promise((resolve) =>
            setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
          );
          continue;
        }

        const response = parseHealthCheckResponse(chunks);
        if (response) {
          return {
            ...response,
            latencyMs: Date.now() - startTime,
          };
        }

        await new Promise((resolve) =>
          setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
        );
      } catch {
        await new Promise((resolve) =>
          setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL)
        );
      }
    }
    return {
      healthy: false,
      error: `Health check timed out after ${timeout}ms`,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function eventPaginationContractError(
  runId: string,
  message: string
): WorkflowWorldError {
  return new WorkflowWorldError(
    `Event pagination ${message} for workflow run "${runId}".`,
    { code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR }
  );
}

function recordRequestedEventCursor(
  runId: string,
  cursor: string | null,
  requestedCursors: Set<string>
): void {
  if (!cursor) {
    return;
  }
  if (requestedCursors.has(cursor)) {
    throw eventPaginationContractError(runId, 'did not advance');
  }
  requestedCursors.add(cursor);
}

/**
 * Appends events whose IDs are not already present in `target`.
 *
 * Pass the IDs currently present in `target` when appending repeatedly to the
 * same array. The set is updated alongside `target`.
 *
 * Events are appended in the order the World returned them, and are not
 * re-sorted. Every append source is already in canonical order relative to the
 * tail (a cursor-delimited page, or a write-response delta), so receipt order is
 * the order to keep, and re-sorting here would only cost a pass over the log.
 * Nothing downstream may assume the tail is the newest event — see
 * {@link maxEventSlot}.
 */
export function appendUniqueEvents(
  target: Event[],
  events: readonly Event[],
  targetIds?: Set<string>
): void {
  if (events.length === 0) {
    return;
  }

  const ids = targetIds ?? new Set(target.map((event) => event.eventId));
  for (const event of events) {
    if (ids.has(event.eventId)) {
      continue;
    }
    ids.add(event.eventId);
    target.push(event);
  }
}

/**
 * Inserts `event` into `target` at the position that keeps `target` ordered by
 * ascending `eventId`, or no-ops if an event with the same `eventId` is already
 * present (idempotent).
 *
 * `preloadedEvents` is loaded `sortOrder: 'asc'` and is never re-sorted
 * client-side, so a `hook_received` spliced in by the lazy-resume consumer must
 * land in `eventId` order — a plain `push` would place a late-committing
 * earlier event after events that sort before it, corrupting replay.
 *
 * Lexicographic string order is the log's order: a slot id is a fixed-width
 * zero-padded position, so comparing the strings compares the positions. This
 * needs no parse of its own for that reason, and the comparison is exact rather
 * than a reconstruction.
 */
export function insertEventByEventId(target: Event[], event: Event): void {
  // Linear scan from the end: the spliced event is almost always the newest
  // (it sorts at or near the tail), so this finds the slot in O(1)–O(k) for the
  // common case while still handling an out-of-order late arrival correctly.
  let i = target.length;
  while (i > 0) {
    const existing = target[i - 1];
    if (existing.eventId === event.eventId) {
      // Already present — keep the splice idempotent.
      return;
    }
    if (existing.eventId < event.eventId) {
      break;
    }
    i--;
  }
  target.splice(i, 0, event);
}

function assertEventPaginationProgress(
  runId: string,
  hasMore: boolean,
  cursor: string | null,
  requestedCursors: Set<string>
): void {
  if (!hasMore) {
    return;
  }
  if (cursor === null) {
    throw eventPaginationContractError(
      runId,
      'returned more pages without a cursor'
    );
  }
  if (requestedCursors.has(cursor)) {
    throw eventPaginationContractError(runId, 'repeated a cursor');
  }
}

function shouldRetryWithoutEventCursor(
  error: unknown,
  cursor: string | null,
  alreadyRetried: boolean
): boolean {
  return (
    cursor !== null &&
    !alreadyRetried &&
    WorkflowWorldError.is(error) &&
    error.status === 400
  );
}

/**
 * Loads workflow run events by iterating through all pages of paginated
 * results. Events are returned in chronological (ascending) order for
 * deterministic workflow replay.
 *
 * @param runId - The workflow run ID.
 * @param afterCursor - If provided, only events after this cursor are
 *   returned (incremental load). If omitted, all events are returned.
 *   The returned cursor can be passed back in on a subsequent call for
 *   incremental loading.
 */
export async function loadWorkflowRunEvents(
  runId: string,
  afterCursor?: string,
  onEvent?: EventStreamObserver
): Promise<LoadedEventLog> {
  const incremental = afterCursor !== undefined;
  return trace(
    incremental ? 'workflow.loadNewEvents' : 'workflow.loadEvents',
    async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
      });

      const loadedEvents: Event[] = [];
      const loadedEventIds = new Set<string>();
      const requestedCursors = new Set<string>();
      let cursor: string | null = afterCursor ?? null;
      let hasMore = true;
      let pagesLoaded = 0;
      let retriedWithoutCursor = false;

      const world = await getWorldLazy();
      const loadStart = Date.now();
      while (hasMore) {
        // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
        // to lazyload the data from the world instead so that we can optimize and make the event log loading
        // much faster and memory efficient
        const pageStart = Date.now();
        const requestedCursor = cursor;
        recordRequestedEventCursor(runId, requestedCursor, requestedCursors);

        let response: Awaited<ReturnType<typeof world.events.list>>;
        try {
          response = await world.events.list({
            runId,
            pagination: {
              sortOrder: 'asc',
              cursor: requestedCursor ?? undefined,
            },
            onEvent,
          });
        } catch (error) {
          if (
            shouldRetryWithoutEventCursor(
              error,
              requestedCursor,
              retriedWithoutCursor
            )
          ) {
            runtimeLogger.warn(
              'Event cursor was rejected; retrying with a full event reload.',
              { workflowRunId: runId }
            );
            loadedEvents.length = 0;
            loadedEventIds.clear();
            requestedCursors.clear();
            cursor = null;
            retriedWithoutCursor = true;
            continue;
          }
          throw error;
        }

        appendUniqueEvents(loadedEvents, response.data, loadedEventIds);
        hasMore = response.hasMore;
        assertEventPaginationProgress(
          runId,
          hasMore,
          response.cursor,
          requestedCursors
        );
        // Preserve the last non-null cursor across pages. A World may
        // legitimately return `{ data: [], cursor: null, hasMore: false }`
        // on a trailing empty page — for example when the previous page's
        // underlying DB query hit the limit exactly and returned a
        // `LastEvaluatedKey` "just in case". Overwriting with that null
        // would lose the position past the last real event we loaded and
        // force the runtime into the "no cursor after initial load" full-
        // reload fallback on every subsequent replay iteration.
        cursor = response.cursor ?? cursor;
        pagesLoaded++;

        runtimeLogger.debug('Loaded event page', {
          workflowRunId: runId,
          incremental,
          page: pagesLoaded,
          pageEvents: response.data.length,
          totalEvents: loadedEvents.length,
          hasMore,
          pageMs: Date.now() - pageStart,
        });
      }

      runtimeLogger.debug('Event load complete', {
        workflowRunId: runId,
        incremental,
        totalEvents: loadedEvents.length,
        pagesLoaded,
        totalMs: Date.now() - loadStart,
      });

      span?.setAttributes({
        ...Attribute.WorkflowEventsCount(loadedEvents.length),
        ...Attribute.WorkflowEventsPagesLoaded(pagesLoaded),
      });

      return { events: loadedEvents, cursor };
    }
  );
}

/**
 * The runtime's loaded event-log snapshot: the events replayed so far and the
 * cursor positioned after them. Handed to helpers that derive the precondition
 * snapshot from it; they do not mutate it.
 */
export interface LoadedEventLog {
  events: Event[];
  cursor: string | null;
}

/**
 * Whether a replay refuses to run over a log with a hole in it (see
 * {@link findEventSlotGap}). **On by default**; set
 * `WORKFLOW_SLOT_GAP_CHECK=0` to replay across holes instead.
 *
 * A World that allocates a position at the moment it commits leaves no hole
 * behind when a write fails, so density is a property the log has by
 * construction rather than one this check maintains. What the check is for is
 * the reads and the Worlds where that does not hold, and by the time it runs
 * the benign explanations are spent: a position missing because a concurrent
 * commit is not visible yet clears on a re-read, which is what
 * {@link settleEventSlotGap} does first.
 *
 * What is left is a hole that persists, and its two causes are
 * indistinguishable from the log. Either a World allocated the position outside
 * the commit and lost the write, in which case nothing happened there and
 * replaying past it is correct, or an event that did happen is missing, in
 * which case replaying past it decides a branch on absence and produces a wrong
 * result with nothing to show for it. Failing is the recoverable side of that
 * trade, and this is the way back out if a fleet turns out to carry holes of
 * the first kind.
 */
export function isSlotGapCheckEnabled(): boolean {
  return process.env.WORKFLOW_SLOT_GAP_CHECK !== '0';
}

/*
 * Merging into a log a replay is midway through reading.
 *
 * Three paths add events to a loaded log after the replay has started: a
 * bump-and-report write hands back the slots it skipped ({@link
 * mergeReportedEvents}), an inline delta extends the tail (`absorbCreateDelta`
 * in `runtime.ts`), and a listed page appends ({@link appendUniqueEvents}).
 * They look alarming — the replay is reading an array while something else
 * writes to it — and they are safe for one reason worth stating plainly, since
 * every correctness argument in this file leans on it.
 *
 * **An event in the log is a fact, and a longer log cannot retract one.** The
 * log is append-only and positions are never reused, so a replay that produced
 * event E from the prefix it had loaded has made E true for every replay that
 * follows. A later replay reading a fuller log does not get to decide E should
 * not be there; it consumes E and reconciles to it, which is what the events
 * consumer does when it walks a log holding writes from a replay that raced it.
 *
 * Merging is therefore monotone: it can only add facts this replay has yet to
 * reconcile to, never remove one it already has. That is why absorbing is
 * always optional and never wrong to decline — an unabsorbed event is one the
 * next read returns — and why the guards below can afford to be strict.
 */

/**
 * Merge the events a bump-and-report write handed back into the log it was
 * derived from, and answer how many of them were new.
 *
 * Unlike {@link appendUniqueEvents}, this re-sorts. The reported events occupy
 * slots *below* the write that reported them, so appending them would put them
 * after events they precede. Sorting by id restores the World's canonical order
 * rather than guessing at it: a slot id is that order, written down.
 */
export function mergeReportedEvents(
  target: Event[],
  events: readonly Event[]
): number {
  const before = target.length;
  appendUniqueEvents(target, events);
  const added = target.length - before;
  if (added > 0) {
    target.sort((a, b) =>
      a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
    );
  }
  return added;
}

/** What {@link absorbSkippedSlotReport} did with a write's report. */
export interface SkippedSlotReport {
  /** How many of the reported events were new to the log. Zero if dropped. */
  added: number;
  /** How many events the report offered, whether or not they were taken. */
  offered: number;
  /** The report was truncated, so it was dropped whole instead of merged. */
  truncated: boolean;
}

/**
 * Apply a write's skipped-slot report to the log it was derived from, deciding
 * whether the report may be taken at all.
 *
 * Every replay-context write can come back carrying the events on the slots it
 * skipped over, and every caller wants the same thing from them: fold them in
 * so the writes that follow name a position above them, and so the replay
 * resuming from this log sees them without a reload.
 *
 * The one policy is that a **truncated report is dropped whole**. It covers a
 * span of positions but carries only some of the events on them, so merging it
 * would raise the log's highest position past a position whose event is
 * missing. Later writes read that maximum to say what they have seen, so each
 * would claim a position it never saw, and the World only reports the span a
 * write skips — it would never send the missing one. Dropping costs one more
 * round of the same events on the next write and keeps the log a prefix of the
 * truth, which the note above {@link mergeReportedEvents} explains is always an
 * available answer.
 *
 * Callers that log do so from the returned counts; the decision is not theirs
 * to re-derive.
 */
export function absorbSkippedSlotReport(
  target: Event[],
  result: { events?: readonly Event[]; hasMore?: boolean }
): SkippedSlotReport {
  const offered = result.events?.length ?? 0;
  if (offered === 0) {
    return { added: 0, offered: 0, truncated: false };
  }
  if (result.hasMore === true) {
    return { added: 0, offered, truncated: true };
  }
  return {
    added: mergeReportedEvents(target, result.events ?? []),
    offered,
    truncated: false,
  };
}

/**
 * The highest slot the loaded log occupies, or `undefined` for an empty log.
 *
 * The maximum, not the count, and the two are not interchangeable even though
 * a healthy log makes them equal. A World hands a position to the insert that
 * occupies it, so a write that never lands leaves no hole behind and the log
 * stays dense. What the count cannot survive is a *partial* read: a log
 * assembled from a truncated report, or read while a concurrent write is
 * committing, holds fewer events than its highest position. Counting those
 * would make the next write claim to have seen less than it has, so the World
 * would report the same events back to it on every attempt.
 *
 * A hole below the maximum is therefore a property of the read, not of the log,
 * which is what lets {@link settleEventSlotGap} re-read instead of giving up.
 *
 * @throws if any event id carries no slot. Every World the runtime replays
 * against numbers events by slot, so an id that does not is a broken log rather
 * than an older one, and a maximum derived by skipping it would understate the
 * log to every write that reads it.
 */
export function maxEventSlot(events: readonly Event[]): number | undefined {
  let max: number | undefined;
  for (const event of events) {
    const slot = requireEventSlot(event.eventId);
    if (max === undefined || slot > max) {
      max = slot;
    }
  }
  return max;
}

/** A position the log skips over, described well enough to name in an error. */
export interface EventSlotGap {
  /** The lowest slot below the log's maximum that no event occupies. */
  firstMissingSlot: number;
  /** How many slots below the maximum no event occupies. */
  missingCount: number;
  /** The highest slot the log occupies. */
  maxSlot: number;
}

/**
 * The hole in a loaded log, or `undefined` when there is none to find.
 *
 * The World allocates every position, so a log that holds `n` events below slot
 * `n` is missing one. That matters before a replay
 * and nowhere else: the replay reads the log as the complete record of what has
 * happened, and an absent position is indistinguishable from an event that
 * never occurred. The branch it would have decided gets decided the other way,
 * and the run diverges quietly rather than failing.
 *
 * Order-independent, unlike the equivalent audit the World runs over a page it
 * just read. A loaded log is assembled from listed pages plus whatever a
 * bump-and-report write handed back, and while {@link mergeReportedEvents}
 * restores id order, a check that can fail a healthy run should not depend on
 * that having happened.
 *
 * The first slot is never counted. It belongs to `run_created`, which `start()`
 * posts concurrently with the queue send, so a log read in that window
 * legitimately begins at the second slot and fills in on its own. Every replay
 * that races a run's own start would otherwise report a hole.
 *
 * Returns `undefined` for an empty log, which has no density to check.
 *
 * @throws if any event id carries no slot, for the reason {@link maxEventSlot}
 * gives.
 */
export function findEventSlotGap(
  events: readonly Event[]
): EventSlotGap | undefined {
  const occupied = new Set<number>();
  let maxSlot = 0;
  for (const event of events) {
    const slot = requireEventSlot(event.eventId);
    occupied.add(slot);
    if (slot > maxSlot) {
      maxSlot = slot;
    }
  }
  if (maxSlot === 0) {
    return undefined;
  }
  const floor = occupied.has(FIRST_EVENT_SLOT)
    ? FIRST_EVENT_SLOT
    : FIRST_EVENT_SLOT + 1;
  // Every slot is at or above `floor` by construction, so the log is dense
  // exactly when it holds one event per position in `[floor, maxSlot]`. The
  // scan below only runs once that has already answered no.
  if (occupied.size === maxSlot - floor + 1) {
    return undefined;
  }
  let firstMissingSlot: number | undefined;
  let missingCount = 0;
  for (let slot = floor; slot <= maxSlot; slot++) {
    if (!occupied.has(slot)) {
      firstMissingSlot ??= slot;
      missingCount++;
    }
  }
  if (firstMissingSlot === undefined) {
    return undefined;
  }
  return { firstMissingSlot, missingCount, maxSlot };
}

/**
 * How many times a detected hole is re-read before the log is taken at its
 * word, and the backoff before each re-read (doubling per attempt).
 *
 * A hole can be transient. The World allocates a slot inside the insert that
 * occupies it, so two concurrent writers can collide, one retry past the other,
 * and the higher slot commit first — leaving a window in which the lower one is
 * genuinely absent from a strongly-consistent read and fills in a moment later.
 * The window is one commit wide, so a short backoff clears it; anything that
 * survives all three re-reads is a position no write will ever occupy.
 */
export const SLOT_GAP_RECHECK_ATTEMPTS = 3;
const SLOT_GAP_RECHECK_BASE_DELAY_MS = 25;

/**
 * Re-read a log that looks holey until the hole fills in or the re-reads run
 * out, and return the settled log alongside the hole that survived.
 *
 * Reads are strongly consistent, so a hole is not an artifact of *when* the log
 * was read — but it can be an artifact of a write that had not committed yet
 * (see {@link SLOT_GAP_RECHECK_ATTEMPTS}). Distinguishing the two costs a
 * re-read, which is only ever paid by a replay that already found a hole.
 *
 * The reload is full rather than incremental: the missing position is below the
 * log's maximum, so a cursor-anchored read starts past it and can never see it
 * arrive.
 */
export async function settleEventSlotGap(
  runId: string,
  loaded: LoadedEventLog
): Promise<{ log: LoadedEventLog; gap: EventSlotGap | undefined }> {
  let log = loaded;
  let gap = findEventSlotGap(log.events);
  for (
    let attempt = 0;
    gap !== undefined && attempt < SLOT_GAP_RECHECK_ATTEMPTS;
    attempt++
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, SLOT_GAP_RECHECK_BASE_DELAY_MS * 2 ** attempt)
    );
    log = await loadWorkflowRunEvents(runId);
    gap = findEventSlotGap(log.events);
  }
  return { log, gap };
}

/**
 * How much of its run's log a replay-context event creation had loaded when it
 * decided to write, as the highest slot that log occupies.
 *
 * One integer says it because the World keeps its positions dense: a writer
 * that names slot N is claiming to hold every event from 1 to N and nothing
 * above. The World answers by numbering the write above whatever the log has
 * actually reached and handing back the events on the slots in between — the
 * ones this writer decided without.
 *
 * Density is the World's invariant, not a claim about this particular read. A
 * reader that is short of a position it holds no event for names a lower N,
 * which understates what it has seen and only costs it a wider report. Naming
 * a position it cannot account for is the direction that is unsafe, which is
 * why {@link slotSnapshotParams} takes the maximum rather than the count.
 *
 * Its own object rather than a bare number so a call site cannot half-send it,
 * and so the empty case spreads to nothing.
 */
export interface SlotSnapshotParams {
  eventCount?: number;
}

/**
 * Build the slot snapshot to attach to a replay-context event creation.
 *
 * Empty for an empty log, which is the state a `run_created` write is issued
 * from: there is no position held yet to name.
 *
 * The maximum rather than the length, for the reason {@link maxEventSlot}
 * gives: a partially-read log holds fewer events than its highest position, and
 * counting those would make the write claim to have seen less than it has, so
 * the World would report the same events back on every attempt.
 */
export function slotSnapshotParams(
  events: readonly Event[]
): SlotSnapshotParams {
  const eventCount = maxEventSlot(events);
  return eventCount === undefined ? {} : { eventCount };
}

/**
 * The events a rejecting World attached to a `PreconditionFailedError`, when it
 * returned the ones the client's snapshot was missing inline.
 *
 * Returns `null` for anything else — no details, a World that did not implement
 * this, or a payload that does not narrow cleanly. Callers fall back to
 * reloading the event log, which is always correct; this is untrusted-shaped
 * data on a failure path, so nothing here is repaired.
 *
 * `runId` is the caller's run. Every event must belong to it: the delta is
 * merged straight into the replay's log, and one foreign event there is a
 * corrupt log rather than a corrected one — the replay would consume a
 * correlation id for an event that does not exist on this run.
 */
export function preconditionEventDelta(
  error: unknown,
  runId: string
): { events: Event[]; cursor: string | null } | null {
  if (!PreconditionFailedError.is(error)) {
    return null;
  }
  const details = error.details;
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const { events, cursor } = details as { events?: unknown; cursor?: unknown };
  if (!Array.isArray(events) || events.length === 0) {
    return null;
  }
  for (const event of events) {
    if (
      typeof event !== 'object' ||
      event === null ||
      typeof (event as { eventId?: unknown }).eventId !== 'string' ||
      (event as { runId?: unknown }).runId !== runId
    ) {
      return null;
    }
  }
  return {
    events: events as Event[],
    cursor: typeof cursor === 'string' ? cursor : null,
  };
}

/** Creates one event on a bound run, carrying replay-recovery telemetry. */
export type EventCreator = (
  data: CreateEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

/**
 * CORS headers for health check responses.
 * Allows the observability UI to check endpoint health from a different origin.
 */
const HEALTH_CHECK_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Wraps a request/response handler and adds a health check "mode"
 * based on the presence of a `__health` query parameter.
 */
export function withHealthCheck(
  handler: (req: Request) => Promise<Response>,
  worldSpecVersion?: number
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const isHealthCheck = url.searchParams.has('__health');
    if (isHealthCheck) {
      // Handle CORS preflight for health check
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: HEALTH_CHECK_CORS_HEADERS,
        });
      }
      return new Response(
        JSON.stringify({
          healthy: true,
          endpoint: url.pathname,
          specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT,
          workflowCoreVersion,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...HEALTH_CHECK_CORS_HEADERS,
          },
        }
      );
    }
    return await handler(req);
  };
}

/** FNV-1a 32-bit hash of a string, as 8 hex chars. Tiny, deterministic, and
 *  dependency-free — used only to scope idempotency keys, not for security. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Idempotency key for a step's background-dispatch queue message, scoped to
 * the step's IDENTITY — correlation id plus (hashed) step name — rather than
 * the bare correlation id.
 *
 * The scoping matters for resilient step dispatch under the precondition
 * guard: a guard-rejected `step_created` leaves its (revoked) step message in
 * flight, and the corrected replay may re-derive the same correlation id for
 * a DIFFERENT step. Under a bare-correlationId key the corrected replay's
 * dispatch would silently dedupe against the revoked in-flight message —
 * which then resolves `skipped` against the re-created entity (the server's
 * stepName fence rejects its bare start) — and the legitimate step would
 * never be executed. Scoping by step name keeps every dedup property that
 * matters (crash recovery re-dispatch, concurrent handlers, the delayed
 * retry sharing the suspension re-dispatch's key — all name the same step)
 * while letting the corrected schedule's dispatch through.
 *
 * Every producer of a step-dispatch (or step-retry) message must use this
 * key. Cross-version mixing is not a concern: queue messages are pinned to
 * the deployment that produced them, so one run never sees two key schemes.
 */
export function stepDispatchIdempotencyKey(
  correlationId: string,
  stepName: string
): string {
  return `${correlationId}:${fnv1a32Hex(stepName)}`;
}

/**
 * Queues a message to the specified queue with tracing.
 */
export async function queueMessage(
  world: World,
  ...args: Parameters<typeof world.queue>
) {
  const queueName = args[0];
  await trace(
    'queue.publish',
    {
      // Standard OTEL messaging conventions
      attributes: {
        ...Attribute.MessagingSystem('vercel-queue'),
        ...Attribute.MessagingDestinationName(queueName),
        ...Attribute.MessagingOperationType('publish'),
        // Peer service for Datadog service maps
        ...Attribute.PeerService('vercel-queue'),
        ...Attribute.RpcSystem('vercel-queue'),
        ...Attribute.RpcService('vqs'),
        ...Attribute.RpcMethod('publish'),
      },
      kind: await getSpanKind('PRODUCER'),
    },
    async (span) => {
      const { messageId } = await world.queue(...args);
      if (messageId) {
        span?.setAttributes(Attribute.MessagingMessageId(messageId));
      }
    }
  );
}

/**
 * Calculates the queue overhead time in milliseconds for a given message.
 */
export function getQueueOverhead(message: { requestedAt?: Date }) {
  if (!message.requestedAt) return;
  try {
    return Attribute.QueueOverheadMs(
      Date.now() - message.requestedAt.getTime()
    );
  } catch {
    return;
  }
}

/**
 * Returns a memoized accessor for a run's full encryption capability.
 *
 * The first call resolves the run's key material via
 * `world.getEncryptionKeyForRun` (which may do HKDF derivation locally on
 * Vercel, or a network fetch from external contexts) and derives a
 * {@link PayloadKey} from it; subsequent calls await the same cached promise.
 * If the world doesn't support encryption or the run has no key configured,
 * the cached value is `undefined`.
 *
 * The resolved value is deliberately the *full* capability — the symmetric AES
 * key plus the run's X25519 keypair — not just a `CryptoKey`. A run reading
 * its own event log can encounter sealed (`encp`) payloads that another run
 * wrote to it (a cross-deployment hook resumption, say), and opening those
 * needs the keypair. Resolving only the symmetric key would leave those
 * payloads unopenable and wedge the run.
 *
 * Used by step / workflow handlers to defer the (potentially expensive)
 * key fetch until the first code path that actually needs it — typically
 * input hydration on the success path, or error dehydration on a failure
 * path. Both paths can race-call the accessor without triggering duplicate
 * fetches.
 *
 * Errors thrown by `getEncryptionKeyForRun` propagate to every caller
 * (the cached promise rejects). This is intentional: when encryption is
 * configured, we never want to silently fall back to plaintext
 * serialization. A propagated error in an event-emission path leaves the
 * outer try/catch to log and surface the issue; the queue's redelivery
 * semantics will retry the key fetch on the next attempt.
 */
export function memoizeEncryptionKey(
  world: World,
  runOrId: WorkflowRun | string,
  context?: Record<string, unknown>
): () => Promise<DecryptionKey | undefined> {
  let cached: Promise<DecryptionKey | undefined> | undefined;
  return () => {
    if (!cached) {
      cached = (async () => {
        // The `getEncryptionKeyForRun` overload set takes either a
        // `WorkflowRun` or a `runId: string` (with optional context). Branch
        // here so TypeScript picks the right overload for each shape.
        const rawKey =
          typeof runOrId === 'string'
            ? await world.getEncryptionKeyForRun?.(runOrId, context)
            : await world.getEncryptionKeyForRun?.(runOrId);
        // Resolve the *full* capability, not just the symmetric key: a run
        // reading its own event log may encounter sealed (`encp`) payloads
        // that another run wrote to it, and opening those needs the run's
        // X25519 scalar as well.
        return rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;
      })();
    }
    return cached;
  };
}
