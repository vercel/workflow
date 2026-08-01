import {
  PreconditionFailedError,
  RUN_ERROR_CODES,
  SlotConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  HealthCheckPayload,
  ValidQueueName,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  isSlotId,
  maxSlotOf,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  slotEventId,
  ulidToDate,
  usesSlotIdentity,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { runtimeLogger } from '../logger.js';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import {
  deriveRunPayloadKeys,
  type PayloadKey,
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
 * Appends events whose IDs are not already present in `target`, keeping a
 * slot-numbered log in slot order.
 *
 * Arrival order is not log order under slot identity. A slot is reserved when
 * its event is issued and written when that issue resolves, so a lower slot can
 * be committed after a higher one, and a merge that only appends leaves the
 * array in the order the events were *learned*, not the order they occupy.
 * That difference decides races: the replay consumes this array positionally
 * — the delivery barriers in `pendingDeliveryBarriers` are keyed on the index —
 * so a `step_completed` sitting ahead of a `wait_completed` it actually
 * follows makes the replay take the branch the log does not record, and the
 * next event it reads belongs to a step it never started.
 *
 * Sorting by event id *is* sorting by slot: ids are zero-padded to a fixed
 * width, and a slot-numbered run's log carries no ULID ids to interleave with
 * them.
 *
 * Pass the IDs currently present in `target` when appending repeatedly to the
 * same array. The set is updated alongside `target`.
 *
 * Events are appended in the order the World returned them, and are not
 * re-sorted: a World's canonical order is its own, and the runtime cannot
 * reproduce it from event ids alone. `world-vercel` orders by event id, while
 * `world-local` orders by `(createdAt, eventId)` and deliberately re-mints keys
 * so that the two diverge. Every append source is already in canonical order
 * relative to the tail (a cursor-delimited page, or a write-response delta), so
 * receipt order is the order to keep. Nothing downstream may assume the tail is
 * the newest event — see {@link latestEventStateUpdatedAt}.
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
  let outOfOrder = false;
  for (const event of events) {
    if (ids.has(event.eventId)) {
      continue;
    }
    ids.add(event.eventId);
    outOfOrder ||=
      target.length > 0 && event.eventId < target[target.length - 1].eventId;
    target.push(event);
  }
  if (outOfOrder && isSlotId(target[0].eventId)) {
    target.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  }
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
  afterCursor?: string
): Promise<{ events: Event[]; cursor: string | null }> {
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
 * A loaded snapshot that also tracks the run's event slots, for the numbering
 * where the event id is itself the concurrency fence. Slot state is per-replay:
 * it is rebuilt from the events every time the log is loaded, never carried
 * across a restart.
 */
export interface MutableEventLog extends LoadedEventLog {
  /**
   * Highest slot present in `events`, or 0 for a log that is empty or
   * ULID-numbered. Maintained by `mergeLoadedEvents` from the events merged in,
   * never from the array's last element: events are appended without sorting,
   * so after a merge the last element need not be the newest.
   */
  maxSlot: number;
  /**
   * Next slot `reserveSlot` will hand out. Only a writer holding the log's
   * write chain may draw from it, and it is rewound to `maxSlot + 1` when a
   * claim is rejected so the rest of the batch claims into the occupied range
   * and is rejected with it.
   */
  nextSlot: number;
  /**
   * Tail of the chain of creates numbered off this log, or `undefined` when
   * none is in flight.
   *
   * Slot claims are taken one at a time. A claim only fences out a concurrent
   * writer if it names the slot right after the log's committed tail: numbering
   * a whole concurrent batch up front hands its later writes slots far enough
   * above the tail that a foreign event landing in between clears every fence
   * they carry, and the batch commits decisions taken without it.
   */
  writeChain?: Promise<void>;
}

/**
 * A `MutableEventLog` over a freshly loaded snapshot.
 *
 * `slotFloor` is a slot known to be published that the snapshot may not contain
 * — the run's own `run_started`, whose write turbo backgrounds while replaying
 * against an empty log. Numbering a claim from the snapshot alone would then
 * propose a slot that is already taken, so every first write of a turbo
 * invocation would conflict and cost the run an extra replay.
 */
export function toMutableEventLog(
  events: Event[],
  cursor: string | null,
  slotFloor = 0
): MutableEventLog {
  const maxSlot = Math.max(maxSlotOf(events), slotFloor);
  return {
    events,
    cursor,
    maxSlot,
    nextSlot: maxSlot + 1,
  };
}

/**
 * Merges loaded events into `log` in place, keeping `maxSlot` current and
 * advancing the reservation pointer past the events merged in.
 */
export function mergeLoadedEvents(
  log: MutableEventLog,
  events: readonly Event[]
): void {
  appendUniqueEvents(log.events, events);
  log.maxSlot = Math.max(log.maxSlot, maxSlotOf(events));
  log.nextSlot = Math.max(log.nextSlot, log.maxSlot + 1);
}

/**
 * Claims the next free slot in `log`.
 *
 * Only call this while holding the log's write chain: the claim is the fence,
 * and it only fences anything while it names the slot immediately after the
 * tail this writer has seen.
 */
export function reserveSlot(log: MutableEventLog): number {
  const slot = log.nextSlot;
  log.nextSlot = slot + 1;
  return slot;
}

/**
 * Whether the optimistic-concurrency guard for event creation is enabled.
 * **On by default** where the runtime executes: replay-context creates send a
 * `stateUpdatedAt` snapshot (and can be rejected with 412 by a supporting
 * backend) unless `WORKFLOW_PRECONDITION_GUARD` is set to `0`. Backends without
 * guard support ignore the snapshot, so enabling by default is
 * backward-compatible.
 */
export function isPreconditionGuardEnabled(): boolean {
  return process.env.WORKFLOW_PRECONDITION_GUARD !== '0';
}

/**
 * The `stateUpdatedAt` value to send with a replay-context event creation: the
 * *maximum* ULID time (epoch ms) over the events the runtime has loaded. Returns
 * `undefined` when there are no events or that id is not a decodable ULID.
 *
 * It is the maximum rather than the tail's because the loaded log is in the
 * World's canonical order, which is not necessarily event-id order (see
 * {@link appendUniqueEvents}). The maximum is what lets the count sent alongside
 * it be read as "events at or below this watermark": every loaded event is at or
 * below it, so the count is exactly `events.length`. Reading the tail instead
 * would understate the watermark on a World whose order is not id-ordered, which
 * is safe (it can only weaken detection) but needlessly imprecise.
 *
 * The maximum is found by lexicographic id comparison, decoding only once: the
 * 26-character Crockford ULID encodes its timestamp in the leading 10
 * characters, so the greatest id also carries the greatest time.
 *
 * Granularity: snapshots are epoch-milliseconds, and the backend allows an
 * equal-timestamp snapshot (an up-to-date client must not be rejected). Two
 * out-of-band events landing in the same millisecond where only the first was
 * loaded therefore pass this half of the guard undetected — that is exactly
 * the hole `stateEventCount` closes, since the count of events at or below the
 * watermark differs even when the watermarks are equal.
 */
export function latestEventStateUpdatedAt(events: Event[]): number | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (latest === undefined || event.eventId > latest) {
      latest = event.eventId;
    }
  }
  if (latest === undefined) {
    return undefined;
  }
  // Event IDs are prefixed ULIDs (e.g. `evnt_01ARYZ...`); ulidToDate only
  // decodes the bare 26-char ULID, so strip the prefix first.
  const eventId = latest;
  const underscore = eventId.lastIndexOf('_');
  const rawUlid = underscore === -1 ? eventId : eventId.slice(underscore + 1);
  const time = ulidToDate(rawUlid)?.getTime();
  if (time === undefined) {
    // Fail open: a non-decodable id disarms the guard for this create (no
    // snapshot sent). Log so a fleet-wide silent disarm is diagnosable.
    runtimeLogger.debug(
      'Precondition guard: latest event id is not a decodable ULID; sending no snapshot',
      { eventId }
    );
    return undefined;
  }
  return time;
}

/**
 * The precondition snapshot a replay-context event creation sends, describing
 * the event log the replay derived the event from.
 *
 * The three fields are one indivisible unit: the backend reads the count only
 * relative to the watermark, and returns its inline delta only relative to the
 * cursor. Passing them as a single object is what keeps them from drifting
 * apart at a call site.
 */
export interface PreconditionSnapshotParams {
  stateUpdatedAt?: number;
  stateEventCount?: number;
  stateCursor?: string;
}

/**
 * Build the precondition snapshot to attach to a replay-context event creation.
 *
 * Returns an empty object — no guard, backend behaves as before — when the
 * guard is disabled or the watermark is not derivable. All three fields fail
 * open together: a count without a watermark is meaningless to the backend, and
 * a cursor without either would invite a delta nobody asked for.
 *
 * `stateEventCount` is `events.length` because the watermark is the log's
 * *maximum* ULID time, so every loaded event is at or below it regardless of the
 * order the World returned them in.
 *
 * Both fields are therefore invariant under permutation of the log: a maximum is
 * order-independent, and the length is set cardinality once `appendUniqueEvents`
 * has deduped by event id. Two replays that consume the same events in different
 * orders send an identical snapshot, so this guard detects that a log is missing
 * an event and can never detect that a replay consumed one in a different order.
 */
export function preconditionSnapshotParams(
  events: Event[],
  cursor?: string | null
): PreconditionSnapshotParams {
  if (!isPreconditionGuardEnabled()) {
    return {};
  }
  const stateUpdatedAt = latestEventStateUpdatedAt(events);
  if (stateUpdatedAt === undefined) {
    return {};
  }
  return {
    stateUpdatedAt,
    stateEventCount: events.length,
    ...(cursor ? { stateCursor: cursor } : {}),
  };
}

/**
 * Whether a World rejected an event creation because the replay that produced it
 * had not seen the whole event log.
 *
 * The two schemes reject differently and stay separately countable — 412 for the
 * event-log watermark, 409 for a lost slot claim, both live at once while runs on
 * the older numbering drain — but they prove the same thing and are recovered the
 * same way, by restarting the replay over the corrected log.
 */
export function isStaleWriteRejection(error: unknown): boolean {
  return PreconditionFailedError.is(error) || SlotConflictError.is(error);
}

/**
 * The events a rejecting World attached to its rejection, when it returned the
 * ones the client's snapshot was missing inline.
 *
 * A slot conflict carries them as typed fields; the watermark guard carries them
 * in `details`. Both are read here so callers recover from either without
 * branching.
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
  let events: unknown;
  let cursor: unknown;
  if (SlotConflictError.is(error)) {
    // A truncated delta is not a delta: the restart has to see every event it
    // was missing, and only a full reload can guarantee that.
    if (error.hasMore) {
      return null;
    }
    events = error.events;
    cursor = error.cursor;
  } else if (PreconditionFailedError.is(error)) {
    const details = error.details;
    if (typeof details !== 'object' || details === null) {
      return null;
    }
    ({ events, cursor } = details as { events?: unknown; cursor?: unknown });
  } else {
    return null;
  }
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
 * The concurrency fence a replay-context event creation carries. Exactly one of
 * the two schemes is ever populated: the precondition snapshot for a run guarded
 * by the event-log watermark, `eventId`/`maxSlot` for a run that numbers its
 * events by slot.
 */
export interface EventCreateFence extends PreconditionSnapshotParams {
  eventId?: string;
  maxSlot?: number;
}

/**
 * The fence to attach to a replay-context event creation, under whichever
 * scheme the run uses.
 *
 * Neither scheme is retried in place. A rejection under either one proves the
 * replay derived this event from a log that was missing another, and correlation
 * ids are positional ordinals of one sequence — so a replay over the corrected
 * log mints different ids and re-posting this write would persist an event no
 * correct replay produces. Recovery is a restarted replay
 * ({@link isStaleWriteRejection}), never a re-send.
 *
 * Claims a slot off `log` for a slot-numbered run — which counts as a
 * reservation, so a caller that fences several creates from one log gets a
 * distinct slot per create. Empty when the run is fenced neither way, leaving
 * the create exactly as unfenced as it was before either mechanism existed.
 *
 * `extraEvents` is how many events *besides* the one being created this write
 * publishes: a lazy inline `step_started` also materializes the `step_created`
 * it deferred. Those events take the slots immediately below the claim, so this
 * reserves them too and names the top one — a World that writes a pair
 * derives the lower id from the one it was given.
 *
 * The reservation has to happen here rather than at the World or its backend.
 * Slots are handed out for a whole concurrent batch synchronously, before any of
 * it lands, so a second event numbered off the log as the backend sees it would
 * take the slot already promised to the next write in the batch — and every
 * write after the first in a fan-out would lose its claim.
 */
export function eventCreateFenceFor(
  log: MutableEventLog,
  specVersion: number | undefined,
  options?: { extraEvents?: number }
): EventCreateFence {
  if (usesSlotIdentity(specVersion)) {
    return reserveSlotFence(log, options?.extraEvents ?? 0);
  }
  return preconditionSnapshotParams(log.events, log.cursor);
}

/**
 * Reserves this write's slots off `log` and names the one the event itself
 * takes.
 *
 * `extraEvents` sit below the one being created, matching the order a reader
 * expects (a step is created before it starts), so their slots are reserved
 * first and the claim names the last of the run — a World that writes a pair
 * derives the lower id from the one it was given.
 */
function reserveSlotFence(
  log: MutableEventLog,
  extraEvents: number
): EventCreateFence {
  const maxSlot = log.maxSlot;
  for (let i = 0; i < extraEvents; i++) {
    reserveSlot(log);
  }
  return { eventId: slotEventId(reserveSlot(log)), maxSlot };
}

/**
 * Runs one slot-numbered create with the log's claim to itself, taking its slot
 * only once every create ahead of it on the log has settled.
 *
 * A slot claim is an assertion about the tail: "nothing has been published
 * since the view I decided from". Claims handed out up front to a concurrent
 * batch can only assert that about the first of them — the rest sit above slots
 * their own siblings have yet to fill, so a foreign event landing in that space
 * satisfies their fences too and they commit on a view that is already missing
 * it. Taking claims one at a time keeps every write's fence tight against the
 * tail the writer actually saw.
 *
 * A rejection therefore stops the whole batch rather than only its own write:
 * the log's tail stops advancing while the backend's moves on, so the claims
 * behind it fall inside the occupied range and are rejected in turn. That is
 * the intent — the batch was decided from a log missing an event, so none of it
 * should land.
 */
async function withSerializedClaim<T>(
  log: MutableEventLog,
  extraEvents: number,
  op: (fence: EventCreateFence) => Promise<T>
): Promise<T> {
  const ahead = log.writeChain;
  let done!: () => void;
  log.writeChain = new Promise<void>((resolve) => {
    done = resolve;
  });
  if (ahead) {
    await ahead;
  }
  try {
    const fence = reserveSlotFence(log, extraEvents);
    const result = await op(fence);
    log.maxSlot = Math.max(
      log.maxSlot,
      maxSlotOf([{ eventId: fence.eventId ?? '' }])
    );
    log.nextSlot = Math.max(log.nextSlot, log.maxSlot + 1);
    return result;
  } catch (error) {
    // The slots this attempt drew are not the writer's, and the tail is at
    // least as high as the claim that lost. Rewinding onto the occupied range
    // is what makes the rest of the batch fail with it.
    log.nextSlot = log.maxSlot + 1;
    throw error;
  } finally {
    done();
  }
}

/**
 * Runs one event create under whichever fence its run uses.
 */
export type FencedCreate = <T>(
  op: (fence: EventCreateFence | undefined) => Promise<T>
) => Promise<T>;

/**
 * The fenced create for a claim issued from a concurrent batch — an inline
 * step's `step_started`, or a suspension flush's writes.
 *
 * Under slot numbering this serializes the batch's claims so each one is taken
 * against the tail its writer actually saw ({@link withSerializedClaim}); under
 * the watermark every claim in the batch legitimately carries the same
 * snapshot, so they all run concurrently off one fence.
 *
 * Neither scheme re-issues a rejected claim at a free number. A rejection says
 * this replay decided from a log it had not fully seen, and the missing event
 * can be the one that would have sent the workflow down another branch — with
 * correlation ids counted in branch order, every id after that branch moves
 * with it, so the re-issued write would land under an identity that now names a
 * different step. The rejection propagates and the run replays over the
 * corrected log ({@link isStaleWriteRejection}).
 */
export function claimFenceFor(
  log: MutableEventLog,
  specVersion: number | undefined,
  options?: { extraEvents?: number }
): FencedCreate {
  if (usesSlotIdentity(specVersion)) {
    return (op) => withSerializedClaim(log, options?.extraEvents ?? 0, op);
  }
  const fence = eventCreateFenceFor(log, specVersion, options);
  return (op) => op(fence);
}

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
  runOrId: WorkflowRun | string
): () => Promise<PayloadKey | undefined> {
  let cached: Promise<PayloadKey | undefined> | undefined;
  return () => {
    if (!cached) {
      cached = (async () => {
        // The `getEncryptionKeyForRun` overload set takes either a
        // `WorkflowRun` or a `runId: string` (with optional context). Branch
        // here so TypeScript picks the right overload for each shape.
        const rawKey =
          typeof runOrId === 'string'
            ? await world.getEncryptionKeyForRun?.(runOrId)
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
