import type { Analytics } from './analytics.js';
import type {
  AttributeChange,
  ExperimentalSetAttributesResult,
} from './attributes.js';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
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
 * Optional feature capabilities a World implementation declares so the core
 * runtime can enable optimizations that depend on backend behavior, instead
 * of inferring support from environment variables alone. Every capability
 * defaults to "unsupported" when absent — runtime fast paths that rely on
 * one must fail closed (keep their conservative behavior) unless the World
 * explicitly declares it.
 */
export interface WorldCapabilities {
  /**
   * Supports `experimental_minRetention` for Hooks. Missing or inactive means
   * the runtime rejects retained Hooks before registration.
   */
  hookRetention?: {
    active: boolean;
  };

  /**
   * The World enforces the optimistic-concurrency precondition guard: an
   * event creation carrying a `stateUpdatedAt` snapshot is rejected with a
   * `PreconditionFailedError` (412) when a newer out-of-band event (e.g. a
   * received hook) was recorded after that snapshot. Worlds that accept but
   * ignore `stateUpdatedAt` must leave this unset so runtime optimizations
   * that rely on the 412 fence (see `WORKFLOW_PRECONDITION_GUARD`) are not
   * enabled without an actual fence behind them.
   *
   * A World declaring this should honour the whole snapshot the runtime sends,
   * not just the watermark: `stateUpdatedAt`, `stateEventCount` (the count
   * fence, which catches an event missing at or below the watermark — the case
   * the watermark provably cannot see) and, optionally, `stateCursor` (return
   * the missing events on the 412 to save the client a reload). See
   * `CreateEventParams` for each field's contract. The runtime does not branch
   * on which halves are implemented; a World that ignores the count simply
   * fences less.
   */
  preconditionGuard?: boolean;

  /**
   * The World's queue supports `maxConcurrency`-limited consumption — in
   * particular the per-run flow topics consumed with `maxConcurrency: 1`
   * that `WORKFLOW_SEQUENTIAL_REPLAYS=1` uses to serialize a run's
   * orchestrator invocations. Worlds whose queue has no concurrency-limit
   * concept must leave this unset.
   *
   * Note this declares queue *support*, not deployed configuration: the
   * serialization also requires the build-time half (a flow trigger emitted
   * with `maxConcurrency: 1`), which a runtime process cannot verify today.
   * The core runtime therefore does not yet take any fast path from this
   * capability alone — it exists so a future build-verified signal can be
   * combined with it (and so Worlds document the contract explicitly).
   */
  maxConcurrency?: boolean;

  /**
   * The World's `events.create` deduplicates concurrent `hook_received` writes
   * that carry the same `(runId, resumeId)` — collapsing them onto a single
   * committed event and returning the canonical one to every caller. This is
   * the backend half of `resumeHook()`'s parallel fast path: the producer's
   * direct write and the queue consumer's re-ensure both write the same
   * `resumeId`, and exactly one event must survive or the run replays a
   * duplicated `hook_received`.
   *
   * The core runtime fails closed on this: the parallel path is taken ONLY
   * when the World declares `hookResumeDedup === true` AND the target run's
   * deployment can re-ensure from `hookInput` (see the execution-context
   * marker `hookResumeInputVersion`). A World that accepts a `resumeId` but
   * does not enforce the `(runId, resumeId)` constraint must leave this unset
   * so the runtime keeps the sequential single-writer path.
   *
   * Enabled statically for `world-local` (filesystem sidecar claim keyed on
   * `(runId, resumeId)`; the adapter and its backend ship together, so a static
   * capability can never drift from the backend). `world-vercel` deliberately
   * leaves this UNSET and instead attests support per-lookup via the
   * server-computed, response-only `Hook.resumeCapabilities.hookResumeDedupVersion`
   * (see `HookResumeCapabilitiesSchema`), so a server rollback or kill switch
   * degrades new resumes to the sequential path immediately without redeploying
   * the adapter. `world-postgres` leaves it unset for now and stays sequential.
   *
   * The resume gate treats EITHER signal as backend support (see
   * `resume-hook.ts`): this static capability OR a current
   * `resumeCapabilities.hookResumeDedupVersion` on the by-token hook.
   */
  hookResumeDedup?: boolean;

  /**
   * Deployments are atomic and immutable: a deployment id names one fixed
   * build for its whole lifetime, so a run pinned to one may only execute
   * there. Worlds that declare this get the runtime's deployment-affinity
   * guard, which re-routes a misrouted delivery to the run's own deployment
   * and ultimately fails the run with `DEPLOYMENT_MISMATCH`.
   *
   * Worlds whose deployment id is synthetic or version-tagged (e.g.
   * `dpl_local@<sdk-version>`, which legitimately differs across SDK versions
   * within one logical environment) must leave this unset: there a
   * "mismatch" is not a real cross-deployment delivery, and guarding would
   * fail ordinary runs after a version bump.
   */
  deploymentAffinity?: boolean;
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
   * The Workflow protocol spec version this World implements.
   *
   * Current runtimes require this to exactly match their
   * `SPEC_VERSION_CURRENT` before they create or replay runs.
   */
  specVersion: number;

  /**
   * Feature capabilities this World implementation supports — see
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
   * Not all World implementations support this — it is only implemented by
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
   * - `getEncryptionKeyForRun(run)` — Preferred. Pass a `WorkflowRun` when
   *   the run entity already exists. The World reads any context it needs
   *   (e.g., `deploymentId`) directly from the run.
   *
   * - `getEncryptionKeyForRun(runId, context?)` — Used when the run entity
   *   is not locally available, such as `start()` before run creation or a
   *   forwarded writable stream carrying its owning deployment context. The
   *   `context` parameter carries opaque world-specific data (e.g.,
   *   `{ deploymentId }` for world-vercel) needed to resolve the correct key.
   *   When `context` is omitted, the World assumes the current deployment.
   *
   * When not implemented, encryption is disabled — data is stored unencrypted.
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
   *   recognise — for example, `@workflow/world-vercel` reads
   *   `options.region` to embed a region identifier. Unrecognised keys
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
   * this client's writes — for `world-vercel` that means keeping it in lockstep
   * with the `x-vercel-environment` header (proxy path) and the OIDC token's
   * `environment` claim (in-deployment path). A value that merely looks
   * plausible is worse than `undefined`, because callers use it to detect
   * cross-tenant mismatches and a wrong answer manufactures a false one.
   *
   * `start()` stamps this into the queue message's `runInput` so the consuming
   * deployment can tell that a message it was handed was created against a
   * different environment than its own. Not all Worlds have an environment
   * dimension — local dev and Postgres have exactly one tenant, so they omit
   * this and the check is skipped.
   */
  getEnvironment?(): string | undefined;

  /**
   * World-specific display fields for a run.
   *
   * Tooling — e.g. the `workflow inspect` CLI — calls this to enrich a
   * run's listing row / detail output with fields only the world can
   * derive: a region decoded from the run ID, placement read off the
   * run's `executionContext`, a shard, a billing tier, etc. Consumers
   * render each returned key as an additional column/property; when the
   * hook is absent, no extra fields appear at all.
   *
   * The contract:
   * - **Cheap and pure.** Called once per displayed run, so avoid I/O —
   *   prefer deriving fields from the entity you are given.
   * - **Read only what you recognise.** The argument is the run entity
   *   as the caller has it (a full storage run, or a leaner analytics
   *   row) — typed loosely for the same reason as {@link createRunId}.
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
