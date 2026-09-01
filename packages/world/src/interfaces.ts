import type { Analytics } from './analytics.js';
import type {
  AttributeChange,
  ExperimentalSetAttributesResult,
} from './attributes.js';
import type { WorldCapabilities } from './capabilities.js';
import type {
  BatchEventRequest,
  CreateEventBatchParams,
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventBatchResult,
  EventResult,
  GetEventParams,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  RunCreatedEventRequest,
} from './events.js';
import type { GetHookParams, Hook, ListHooksParams } from './hooks.js';
import type { Queue } from './queue.js';
import type {
  BulkCancelWorkflowRunsRequest,
  BulkCancelWorkflowRunsResult,
  GetWorkflowRunParams,
  ListWorkflowRunsParams,
  WaitForTerminalRunStatusParams,
  WorkflowRun,
  WorkflowRunWithoutData,
} from './runs.js';
import type {
  GetChunksOptions,
  PaginatedResponse,
  StreamChunksResponse,
  StreamInfoResponse,
} from './shared.js';
import type {
  GetStepParams,
  ListWorkflowRunStepsParams,
  Step,
  StepWithoutData,
} from './steps.js';

export interface Streamer {
  /**
   * Number of milliseconds a stream waits for additional chunks to arrive
   * before flushing to the underlying transport.
   *
   * Default `0`: the first chunk dispatches immediately, and chunks
   * arriving while a request is in flight coalesce into the next group.
   * Setting this to > 0 trades first-chunk latency for fewer requests.
   *
   * The `WORKFLOW_STREAM_FLUSH_INTERVAL_MS` environment variable, when
   * set, overrides this option.
   *
   * Not supported by all worlds.
   */
  streamFlushIntervalMs?: number;

  streams: {
    write(
      runId: string,
      name: string,
      chunk: string | Uint8Array
    ): Promise<void>;

    /**
     * Write multiple chunks to a stream in a single operation.
     * This is an optional optimization for world implementations that can
     * batch multiple writes efficiently (e.g., single HTTP request for world-vercel).
     *
     * If not implemented, the caller should fall back to sequential write() calls.
     *
     * @param runId - The run ID
     * @param name - The stream name
     * @param chunks - Array of chunks to write, in order
     */
    writeMulti?(
      runId: string,
      name: string,
      chunks: (string | Uint8Array)[]
    ): Promise<void>;

    close(runId: string, name: string): Promise<void>;

    /**
     * Read from a stream starting at the given chunk index.
     * Positive values skip that many chunks from the start (0-based).
     * Negative values start that many chunks before the current end
     * (e.g. -3 on a 10-chunk stream starts at chunk 7). Clamped to 0.
     */
    get(
      runId: string,
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>>;

    list(runId: string): Promise<string[]>;

    /**
     * Fetch stream chunks with cursor-based pagination.
     *
     * Unlike `get` (which returns a live `ReadableStream` that waits
     * for new chunks in real-time), `getChunks` returns a snapshot of currently
     * available chunks in a standard paginated response.
     *
     * @param runId - The workflow run ID that owns the stream
     * @param name - The stream name/ID
     * @param options - Pagination options (limit defaults to 100, max 1000)
     * @returns Paginated chunks with a `done` flag indicating stream completion
     */
    getChunks(
      runId: string,
      name: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse>;

    /**
     * Retrieve lightweight metadata about a stream.
     *
     * Returns the tail index (index of the last known chunk, 0-based) and
     * whether the stream is complete. This is useful for resolving a negative
     * `startIndex` into an absolute position before connecting to a stream.
     *
     * @param runId - The workflow run ID that owns the stream
     * @param name - The stream name/ID
     */
    getInfo(runId: string, name: string): Promise<StreamInfoResponse>;
  };
}

/**
 * Storage interface for workflow data.
 *
 * Workflow storage models an append-only event log, so all state changes are handled through `events.create()`.
 * Run/Step/Hook entities provide materialized views into the current state, but entities can't be modified directly.
 *
 * User-originated state changes are also handled via events:
 * - run_cancelled event for run cancellation
 * - hook_disposed event for explicit hook disposal (optional)
 *
 * When a workflow reaches a terminal state, its Hooks can no longer be resumed.
 * Worlds normally remove them and release their tokens. A Hook with minimum
 * retention remains readable and keeps its token unavailable until its retention
 * ends. A hook_disposed event always removes the Hook and releases its token.
 */
export interface Storage {
  runs: {
    get(
      id: string,
      params: GetWorkflowRunParams & { resolveData: 'none' }
    ): Promise<WorkflowRunWithoutData>;
    get(
      id: string,
      params?: GetWorkflowRunParams & { resolveData?: 'all' }
    ): Promise<WorkflowRun>;
    get(
      id: string,
      params?: GetWorkflowRunParams
    ): Promise<WorkflowRun | WorkflowRunWithoutData>;

    /**
     * Long poll for a run to reach a terminal status (`completed`, `failed`,
     * or `cancelled`), returning the same entity `get` returns.
     *
     * This is how a caller awaiting a run's outcome (`await run.returnValue`)
     * avoids paying interval-poll quantization for it: instead of asking
     * "is it done yet?" every second, it asks once and the World answers the
     * moment the run finishes.
     *
     * The contract:
     *
     * - **Resolve as soon as the run is terminal**, with the run entity in
     *   the shape `params.resolveData` asks for.
     * - **Resolve no later than roughly `params.timeoutMs`** with the latest
     *   snapshot, whatever its status. A timeout is a normal return, never an
     *   error: a run that is still running is a legitimate answer.
     * - **`timeoutMs` is an upper bound, not a lower one.** An
     *   implementation MAY resolve earlier with a non-terminal snapshot. For
     *   example, `@workflow/world-vercel` does when the backend it is talking
     *   to has no long-poll route and it degrades to a plain read. Callers
     *   must therefore pace their own retries rather than assume one call per
     *   `timeoutMs` (the runtime's `Run#pollReturnValue` keeps consecutive
     *   non-terminal observations at least one poll interval apart).
     * - **Fail exactly like `get`.** A missing run throws
     *   `WorkflowRunNotFoundError`; transport failures surface as they would
     *   on any other read.
     *
     * OPTIONAL. Omit it entirely when the World has no way to wait (a
     * deterministic simulator, a store with no change notification) and the
     * runtime keeps interval-polling `get` on
     * `WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS`. There is nothing to declare
     * beyond the method's presence, and no behavior degrades when it is
     * absent: the fast path is strictly additive.
     *
     * Implementations are free to satisfy this however their backend allows,
     * such as a server-side long poll (`world-vercel` holds
     * `GET /v2/runs/:runId/status` open), a change notification
     * (`world-postgres` uses `LISTEN`/`NOTIFY`, `world-local` an in-process
     * emitter), or a tight internal poll, as long as a lost or missing
     * notification degrades to returning a snapshot rather than hanging past
     * the budget.
     */
    waitForTerminalStatus?: {
      (
        id: string,
        params: WaitForTerminalRunStatusParams & { resolveData: 'none' }
      ): Promise<WorkflowRunWithoutData>;
      (
        id: string,
        params?: WaitForTerminalRunStatusParams & { resolveData?: 'all' }
      ): Promise<WorkflowRun>;
      (
        id: string,
        params?: WaitForTerminalRunStatusParams
      ): Promise<WorkflowRun | WorkflowRunWithoutData>;
    };

    /**
     * Retrieves several runs as one snapshot. The result preserves the input
     * order and contains `null` for run IDs that do not exist.
     */
    getMany?: {
      (
        ids: readonly string[],
        params: GetWorkflowRunParams & { resolveData: 'none' }
      ): Promise<(WorkflowRunWithoutData | null)[]>;
      (
        ids: readonly string[],
        params?: GetWorkflowRunParams & { resolveData?: 'all' }
      ): Promise<(WorkflowRun | null)[]>;
      (
        ids: readonly string[],
        params?: GetWorkflowRunParams
      ): Promise<(WorkflowRun | WorkflowRunWithoutData | null)[]>;
    };

    /**
     * Lists canonical workflow storage records.
     *
     * @remarks Observability and inspection usage of this method is
     * deprecated. Use `world.analytics?.runs.list()` for plan-aware
     * observability queries. This storage API remains available for
     * operational and payload-bearing callers.
     */
    list(
      params: ListWorkflowRunsParams & { resolveData: 'none' }
    ): Promise<PaginatedResponse<WorkflowRunWithoutData>>;
    list(
      params?: ListWorkflowRunsParams & { resolveData?: 'all' }
    ): Promise<PaginatedResponse<WorkflowRun>>;
    list(
      params?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>>;

    /**
     * Apply a batch of attribute changes to a run. Merge semantics:
     * - `value: string` upserts the key
     * - `value: null` removes the key
     * - keys not listed in `changes` are untouched
     *
     * Returns the post-merge attribute snapshot on the run.
     *
     * Pass `options.allowReservedAttributes: true` to permit keys
     * starting with the reserved `$` prefix. Default behavior rejects
     * those keys so user code can't accidentally collide with
     * framework / tooling namespaces; framework callers that own a
     * sub-namespace flip this on.
     *
     * OPTIONAL. World implementations may omit this method; the SDK
     * helper (`setAttributes` in `@workflow/core`) feature-detects its
     * absence and no-ops with a one-time warning so third-party /
     * community worlds keep working without adopting the experimental
     * API.
     *
     * EXPERIMENTAL: this method exists as a stopgap until the
     * `attr_set` event type lands in a future spec version. When that
     * happens, `setAttributes` will dispatch through `events.create`
     * instead, and this method is expected to be removed. See the
     * `attributes-mvp` changelog entry for the migration shape.
     */
    experimentalSetAttributes?(
      runId: string,
      changes: AttributeChange[],
      options?: { allowReservedAttributes?: boolean }
    ): Promise<ExperimentalSetAttributesResult>;

    /**
     * Cancel many runs in a single operation, returning a per-run outcome
     * for each requested ID (order preserved) plus an aggregate summary.
     *
     * OPTIONAL. The SDK helper `cancelRuns` in `@workflow/core` falls back to
     * bounded-concurrency single-run cancellation when unavailable.
     */
    cancelMany?(
      request: BulkCancelWorkflowRunsRequest
    ): Promise<BulkCancelWorkflowRunsResult>;
  };

  steps: {
    get(
      runId: string,
      stepId: string,
      params: GetStepParams & { resolveData: 'none' }
    ): Promise<StepWithoutData>;
    get(
      runId: string,
      stepId: string,
      params?: GetStepParams & { resolveData?: 'all' }
    ): Promise<Step>;
    get(
      runId: string,
      stepId: string,
      params?: GetStepParams
    ): Promise<Step | StepWithoutData>;

    list(
      params: ListWorkflowRunStepsParams & { resolveData: 'none' }
    ): Promise<PaginatedResponse<StepWithoutData>>;
    list(
      params: ListWorkflowRunStepsParams & { resolveData?: 'all' }
    ): Promise<PaginatedResponse<Step>>;
    list(
      params: ListWorkflowRunStepsParams
    ): Promise<PaginatedResponse<Step | StepWithoutData>>;
  };

  /**
   * The event log, and the one part of this interface with a requirement the
   * types cannot express: **the World allocates every event id, and every id
   * is a slot**: `evnt_` followed by the event's dense, 1-based position in
   * its run's log, zero-padded to 26 characters. Use `slotToEventId()` to
   * format one.
   *
   * Not a capability to opt into. The runtime reads a position out of every id
   * it loads (`requireEventSlot`) and fails the run if it cannot, so a World
   * whose ids are not positions cannot replay anything at all. Two properties
   * are what the runtime actually relies on:
   *
   * - **Density.** A run's slots are contiguous from 1, so the number of
   *   events a reader holds *is* the position of the last one. That is what
   *   makes {@link CreateEventParams.eventCount} a complete statement of the
   *   writer's snapshot in a single integer, and what lets a reader tell a
   *   complete log from a truncated one by its length.
   * - **Bump and report.** A create never fails because its requested slot is
   *   taken. The World advances to the next free slot, commits there, and
   *   returns the events occupying the slots it skipped over on the success
   *   response (see {@link EventResult.events}). The writer learns its
   *   snapshot was stale without the write being rejected, which is why no
   *   World needs a precondition guard.
   *
   * Allocating at the commit is what makes a reader's log a *prefix* of the
   * run's log rather than a prefix with a hole in it. A World that hands a
   * position out earlier, and can therefore let an event land behind one a
   * reader has already passed, breaks the property every replay depends on.
   */
  events: {
    /**
     * Create a run_created event to start a new workflow run.
     * The runId may be provided by the client or left as null for the server to generate.
     *
     * @param runId - Client-generated runId, or null for server-generated
     * @param data - The run_created event data
     * @param params - Optional parameters for event creation
     * @returns Promise resolving to the created event and run entity
     */
    create<T extends RunCreatedEventRequest>(
      runId: string | null,
      data: T,
      params?: CreateEventParams
    ): Promise<EventResult<T['eventType']>>;

    /**
     * Create an event for an existing workflow run and atomically update the entity.
     * Returns both the event and the affected entity (run/step/hook).
     *
     * @param runId - The workflow run ID (required for all events except run_created)
     * @param data - The event to create
     * @param params - Optional parameters for event creation
     * @returns Promise resolving to the created event and affected entity
     */
    create<T extends CreateEventRequest>(
      runId: string,
      data: T,
      params?: CreateEventParams
    ): Promise<EventResult<T['eventType']>>;

    /**
     * OPTIONAL batch write: append an ordered list of events to the run's
     * log in one durable, atomic-per-attempt write, with a per-event outcome
     * for each (see {@link BatchEventItemResult}). The events land in request
     * order at consecutive slots. A concurrent writer may push the whole
     * batch to slots above the caller's view of the log; no skipped-event
     * report accompanies the result, so a position-tracking caller compares
     * the committed slots against its expectation and reloads the log to
     * observe what landed in between. Its local view stays a strict PREFIX
     * of the log (never a hole), so replaying it stays correct and the
     * next reload self-corrects.
     *
     * Presence of the method IS the capability declaration: the core runtime
     * batches only when the World implements it (and the run's spec version
     * supports slot identity); absent, every write takes the single-event
     * `create` path unchanged. A World must implement it with real
     * atomicity per attempt (a lost race must leave nothing behind) or not
     * implement it at all.
     *
     * Size limits are the caller's problem: Worlds enforce their own caps
     * (world-vercel enforces an event-count cap and a byte budget over frame
     * meta plus inline-bound payloads) and reject an oversized batch with a
     * request-level error. The core fold sizes its chunks accordingly.
     *
     * Not expressible in a batch (Worlds reject the whole batch with a
     * request-level error): `run_created`, `run_started`, `run_cancelled`,
     * `hook_created`, `hook_disposed`, `attr_set`, and more events targeting
     * one entity than a single write can express (the one legal combination
     * is `step_created` followed by `step_started` for the same step, which
     * creates the step born-running: the step's input MUST ride the
     * `step_created`; a `step_started` carrying a payload rejects the whole
     * batch). Events outside this list keep their own ordering requirements:
     * a caller mixing a batch with single writes (hook or attribute events)
     * owns those barriers itself: the core runtime never batches a
     * suspension that carries hook or attribute writes.
     */
    createBatch?(
      runId: string,
      events: BatchEventRequest[],
      params?: CreateEventBatchParams
    ): Promise<EventBatchResult>;

    get(
      runId: string,
      eventId: string,
      params?: GetEventParams
    ): Promise<Event>;

    list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
    listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>>;
  };

  hooks: {
    /**
     * Returns a Hook by ID. A Hook kept by minimum retention remains readable
     * after its run ends, but cannot be resumed.
     */
    get(hookId: string, params?: GetHookParams): Promise<Hook>;
    /**
     * Returns the Hook that owns a token, including a Hook kept by minimum
     * retention after its run ends.
     */
    getByToken(token: string, params?: GetHookParams): Promise<Hook>;
    /**
     * Lists Hooks, including Hooks kept by minimum retention after their runs
     * end.
     */
    list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
  };
}

/**
 * The "World" interface represents how Workflows are able to communicate with the outside world.
 */
export interface World extends Queue, Streamer, Storage {
  /**
   * Optional analytics read namespace for observability surfaces.
   *
   * These APIs return metadata-only rows intended for UI/CLI listing and
   * trace views. Payload-bearing fields remain on the canonical runtime
   * storage APIs (`runs`, `steps`, `events`, `hooks`) and their RemoteRef
   * resolution path.
   */
  analytics?: Analytics;

  /**
   * The Workflow protocol spec version this World implements, and the version
   * stamped on every run it creates.
   *
   * Declare `SPEC_VERSION_CURRENT` rather than a literal. The runtime checks
   * this against `[SPEC_VERSION_CURRENT, SPEC_VERSION_MAX_SUPPORTED]` before it
   * creates or replays anything, and refuses a World outside that range: below
   * the floor the World allocates event ids the runtime cannot read positions
   * out of (see the event log contract above), above the ceiling it speaks a
   * spec this runtime has not learned.
   */
  specVersion: number;

  /**
   * Feature capabilities this World implementation supports. See
   * {@link WorldCapabilities}. Absent (or absent members) means
   * "unsupported": runtime optimizations gated on a capability fail closed.
   */
  capabilities?: WorldCapabilities;

  /**
   * Absolute wall-clock time when the current function invocation will be
   * terminated by the hosting platform, if known. Used to optimize runtime behavior.
   */
  getRuntimeDeadline?(): Promise<Date | undefined>;

  /**
   * A function that will be called to start any background tasks needed by the World implementation.
   * For example, in the case of a queue backed World, this would start the queue processing.
   */
  start?(): Promise<void>;

  /**
   * Release any resources held by the World implementation (connection pools, listeners, etc.).
   * After calling `close()`, the World instance should not be used again.
   *
   * This is important for CLI commands and short-lived processes that need to exit cleanly
   * without relying on `process.exit()`.
   */
  close?(): Promise<void>;

  /**
   * Resolve the most recent deployment ID for the current deployment's environment.
   *
   * Used when `deploymentId: 'latest'` is passed to `start()`. The implementation
   * determines the latest deployment that shares the same environment (e.g., same
   * "production" target or same git branch for "preview" deployments) as the
   * current deployment.
   *
   * Not all World implementations support this: it is only implemented by
   * world-vercel where deployment routing is meaningful.
   */
  resolveLatestDeploymentId?(): Promise<string>;

  /**
   * Retrieve the AES-256 encryption key for a specific workflow run.
   *
   * The returned key is a ready-to-use 32-byte AES-256 key. The World
   * implementation handles all key retrieval and derivation internally
   * (e.g., HKDF from a deployment key). The core encryption module uses
   * this key directly for AES-GCM encrypt/decrypt operations.
   *
   * Two overloads:
   *
   * - `getEncryptionKeyForRun(run)`: Preferred. Pass a `WorkflowRun` when
   *   the run entity already exists. The World reads any context it needs
   *   (e.g., `deploymentId`) directly from the run.
   *
   * - `getEncryptionKeyForRun(runId, context?)`: Used when the run entity
   *   is not locally available, such as `start()` before run creation or a
   *   forwarded writable stream carrying its owning deployment context. The
   *   `context` parameter carries opaque world-specific data (e.g.,
   *   `{ deploymentId }` for world-vercel) needed to resolve the correct key.
   *   When `context` is omitted, the World assumes the current deployment.
   *
   * When not implemented, encryption is disabled: data is stored unencrypted.
   */
  getEncryptionKeyForRun?(run: WorkflowRun): Promise<Uint8Array | undefined>;
  getEncryptionKeyForRun?(
    runId: string,
    context?: Record<string, unknown>
  ): Promise<Uint8Array | undefined>;

  /**
   * Mint a new workflow run ID.
   *
   * Called by `start()` to generate the unique ID for a newly-created run.
   * The returned value is the "bare" ID (without any `wrun_` prefix); the
   * core attaches the prefix.
   *
   * Implementations are free to embed world-specific metadata in the ID
   * (e.g., a region identifier) as long as the returned string remains a
   * valid ULID. When omitted, `start()` falls back to generating a standard
   * monotonic ULID.
   *
   * @param options - The full options bag passed to `start()` (typed as
   *   `Record<string, unknown>` here to avoid a circular dependency with
   *   `@workflow/core`). Worlds should read only the fields they
   *   recognize. For example, `@workflow/world-vercel` reads
   *   `options.region` to embed a region identifier. Unrecognized keys
   *   must be ignored. `start()` always passes an object (an empty one
   *   when it was called with no options), but implementations should
   *   tolerate `undefined` for direct callers.
   */
  createRunId?(options?: Readonly<Record<string, unknown>>): string;

  /**
   * The environment this World's writes are attributed to by the backend
   * (`@workflow/world-vercel`: `'production' | 'preview' | 'development'`).
   *
   * Synchronous and side-effect free: implementations derive this from
   * configuration or environment variables they already hold, never from a
   * network call. Return `undefined` when the environment can't be determined.
   *
   * The value MUST match the attribution the backend will actually apply to
   * this client's writes: for `world-vercel` that means keeping it in lockstep
   * with the `x-vercel-environment` header (proxy path) and the OIDC token's
   * `environment` claim (in-deployment path). A value that merely looks
   * plausible is worse than `undefined`, because callers use it to detect
   * cross-tenant mismatches and a wrong answer manufactures a false one.
   *
   * `start()` stamps this into the queue message's `runInput` so the consuming
   * deployment can tell that a message it was handed was created against a
   * different environment than its own. Not all Worlds have an environment
   * dimension: local dev and Postgres have exactly one tenant, so they omit
   * this and the check is skipped.
   */
  getEnvironment?(): string | undefined;

  /**
   * World-specific display fields for a run.
   *
   * Tooling (e.g. the `workflow inspect` CLI) calls this to enrich a
   * run's listing row / detail output with fields only the world can
   * derive: a region decoded from the run ID, placement read off the
   * run's `executionContext`, a shard, a billing tier, etc. Consumers
   * render each returned key as an additional column/property; when the
   * hook is absent, no extra fields appear at all.
   *
   * The contract:
   * - **Cheap and pure.** Called once per displayed run, so avoid I/O.
   *   Prefer deriving fields from the entity you are given.
   * - **Read only what you recognize.** The argument is the run entity
   *   as the caller has it (a full storage run, or a leaner analytics
   *   row), typed loosely for the same reason as {@link createRunId}.
   *   Tolerate missing fields.
   * - **Must not throw.**
   * - A `null` field value means "applicable but undeterminable" and is
   *   preserved as `null` in structured output (vs. the hook being
   *   absent, where the key does not exist at all). Return `null` or an
   *   empty object to add nothing for a given run.
   */
  describeRun?(
    run: Readonly<Record<string, unknown>>
  ):
    | Record<string, string | null>
    | null
    | Promise<Record<string, string | null> | null>;
}
