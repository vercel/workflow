// Generated from the Smithy model. Do not edit by hand.
// Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py

import type {
  BatchGetRunsInput,
  BatchGetRunsOutput,
  BulkCancelRunsInput,
  BulkCancelRunsOutput,
  CloseStreamInput,
  CloseStreamOutput,
  CreateEventInput,
  CreateRunIdInput,
  CreateRunIdOutput,
  CreateRunInput,
  DeliverQueueMessageInput,
  DeliverQueueMessageOutput,
  DescribeRunInput,
  DescribeRunOutput,
  EnqueueInput,
  EnqueueOutput,
  EventMutationResult,
  GetDeploymentIdInput,
  GetDeploymentIdOutput,
  GetEncryptionKeyForRunInput,
  GetEncryptionKeyForRunOutput,
  GetEnvironmentInput,
  GetEnvironmentOutput,
  GetEventInput,
  GetEventOutput,
  GetHookByTokenInput,
  GetHookByTokenOutput,
  GetHookInput,
  GetHookOutput,
  GetRunInput,
  GetRunOutput,
  GetRuntimeDeadlineInput,
  GetRuntimeDeadlineOutput,
  GetStepInput,
  GetStepOutput,
  GetStreamInfoInput,
  GetStreamInfoOutput,
  GetWorldInfoInput,
  GetWorldInfoOutput,
  ListEventsByCorrelationIdInput,
  ListEventsByCorrelationIdOutput,
  ListEventsInput,
  ListEventsOutput,
  ListHooksInput,
  ListHooksOutput,
  ListRunsInput,
  ListRunsOutput,
  ListStepsInput,
  ListStepsOutput,
  ListStreamChunksInput,
  ListStreamChunksOutput,
  ListStreamsInput,
  ListStreamsOutput,
  ReadStreamInput,
  ReadStreamOutput,
  WriteStreamChunkInput,
  WriteStreamChunkOutput,
  WriteStreamChunksInput,
  WriteStreamChunksOutput,
} from './models/models_0';

/**
 * Optional optimizations.
 *
 * An implementation that omits this service is fully supported; callers
 * fall back to the equivalent `WorldCore` operations.
 */
export interface WorldBatchPort {
  /**
   * Reads several runs as one snapshot.
   *
   * `runs` preserves the request order, including duplicate IDs, and carries
   * a null entry for every ID that does not exist.
   *
   * Optional capability: `batchGetRuns`. Throws: BadRequestError,
   * InternalError, ThrottledError.
   */
  batchGetRuns(input: BatchGetRunsInput): Promise<BatchGetRunsOutput>;

  /**
   * Cancels many runs in one request.
   *
   * Missing, already-cancelled, and non-cancellable runs are reported as
   * per-run outcomes rather than as operation errors, so one bad ID never
   * fails the batch.
   *
   * Optional capability: `bulkCancelRuns`. Throws: BadRequestError,
   * InternalError, ThrottledError.
   */
  bulkCancelRuns(input: BulkCancelRunsInput): Promise<BulkCancelRunsOutput>;

  /**
   * Appends several chunks in order, in one request.
   *
   * An optional optimization. Callers fall back to repeated
   * `WriteStreamChunk` calls when an implementation does not provide it.
   *
   * Optional capability: `writeStreamChunks`. Throws: ConflictError,
   * InternalError, RunNotFoundError, StreamExpiredError, ThrottledError.
   */
  writeStreamChunks(input: WriteStreamChunksInput): Promise<WriteStreamChunksOutput>;
}

/**
 * Operations the workflow runtime implements and a World's queue adapter
 * calls.
 */
export interface WorldConsumerPort {
  /**
   * Delivers one queued message to the workflow runtime.
   *
   * This is the reverse direction: a queue adapter calls the runtime.
   * Today's `createQueueHandler` becomes a thin per-language adapter that
   * exposes this operation over whatever the platform hands it, rather than
   * an operation in its own right.
   *
   * Callback: implemented by the runtime, called by the World. Throws:
   * BadRequestError, InternalError.
   */
  deliverQueueMessage(input: DeliverQueueMessageInput): Promise<DeliverQueueMessageOutput>;
}

/**
 * The required World surface.
 *
 * Every implementation provides all of it. Optional behavior lives in the
 * capability services instead, so a generated interface never forces an
 * implementation to stub a method it does not support.
 *
 * No protocol trait is applied anywhere in this model. The operations are
 * transport-independent by construction: an in-process implementation
 * satisfies the generated interface directly, and any wire format is a
 * separate projection that layers protocol and binding traits on top.
 */
export interface WorldCorePort {
  /**
   * Closes a stream. No further chunks may be appended.
   *
   * Throws: InternalError, RunNotFoundError, StreamExpiredError,
   * StreamNotFoundError, ThrottledError.
   */
  closeStream(input: CloseStreamInput): Promise<CloseStreamOutput>;

  /**
   * Appends an event to a run's log and materializes its effect atomically.
   *
   * This is the only way to change run, step, hook, or wait state.
   *
   * Throws: BadRequestError, ConflictError, ExpiredError, InternalError,
   * PreconditionFailedError, RunNotFoundError, ThrottledError,
   * TooEarlyError.
   */
  createEvent(input: CreateEventInput): Promise<EventMutationResult>;

  /**
   * Creates a run.
   *
   * The caller may mint the run ID or leave it absent for the implementation
   * to generate one.
   *
   * Throws: BadRequestError, ConflictError, InternalError, ThrottledError.
   */
  createRun(input: CreateRunInput): Promise<EventMutationResult>;

  /**
   * Enqueues one message. Delivery is at-least-once.
   *
   * Throws: BadRequestError, InternalError, ThrottledError.
   */
  enqueue(input: EnqueueInput): Promise<EnqueueOutput>;

  /**
   * Returns the deployment this World writes as.
   *
   * Throws: InternalError, ThrottledError.
   */
  getDeploymentId(input: GetDeploymentIdInput): Promise<GetDeploymentIdOutput>;

  /**
   * Reads one event.
   *
   * Throws: EventNotFoundError, ExpiredError, InternalError,
   * RunNotFoundError, ThrottledError.
   */
  getEvent(input: GetEventInput): Promise<GetEventOutput>;

  /**
   * Reads one hook by ID.
   *
   * Throws: ExpiredError, HookNotFoundError, InternalError, ThrottledError.
   */
  getHook(input: GetHookInput): Promise<GetHookOutput>;

  /**
   * Reads the hook that currently owns a token, including a retained hook
   * whose run has ended.
   *
   * Throws: ExpiredError, HookNotFoundError, InternalError, ThrottledError.
   */
  getHookByToken(input: GetHookByTokenInput): Promise<GetHookByTokenOutput>;

  /**
   * Reads one run.
   *
   * Throws: ExpiredError, InternalError, RunNotFoundError, ThrottledError.
   */
  getRun(input: GetRunInput): Promise<GetRunOutput>;

  /**
   * Reads one step.
   *
   * Throws: ExpiredError, InternalError, RunNotFoundError,
   * StepNotFoundError, ThrottledError.
   */
  getStep(input: GetStepInput): Promise<GetStepOutput>;

  /**
   * Reads lightweight stream metadata.
   *
   * Useful for resolving a negative `startIndex` into an absolute position
   * before opening a live read.
   *
   * Throws: InternalError, RunNotFoundError, StreamExpiredError,
   * StreamNotFoundError, ThrottledError.
   */
  getStreamInfo(input: GetStreamInfoInput): Promise<GetStreamInfoOutput>;

  /**
   * Reports the implementation's protocol version and capabilities.
   *
   * This replaces inferring support from method presence, which stops
   * working as soon as calls cross a transport where every method always
   * exists.
   *
   * Throws: InternalError, ThrottledError.
   */
  getWorldInfo(input: GetWorldInfoInput): Promise<GetWorldInfoOutput>;

  /**
   * Lists a run's event log.
   *
   * Omitting `limit` requests every remaining event.
   *
   * Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
   * ThrottledError.
   */
  listEvents(input: ListEventsInput): Promise<ListEventsOutput>;

  /**
   * Lists the events of one run that share a correlation ID.
   *
   * Correlation IDs are unique within a run, not globally, so the run is
   * part of the query.
   *
   * Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
   * ThrottledError.
   */
  listEventsByCorrelationId(input: ListEventsByCorrelationIdInput): Promise<ListEventsByCorrelationIdOutput>;

  /**
   * Lists hooks, including retained hooks whose runs have ended.
   *
   * Throws: BadRequestError, InternalError, ThrottledError.
   */
  listHooks(input: ListHooksInput): Promise<ListHooksOutput>;

  /**
   * Lists canonical run records.
   *
   * This is the operational, payload-bearing listing. Observability surfaces
   * should prefer the analytics read path once it is modeled.
   *
   * Throws: BadRequestError, InternalError, ThrottledError.
   */
  listRuns(input: ListRunsInput): Promise<ListRunsOutput>;

  /**
   * Lists the steps of one run.
   *
   * Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
   * ThrottledError.
   */
  listSteps(input: ListStepsInput): Promise<ListStepsOutput>;

  /**
   * Reads a point-in-time page of already-written chunks.
   *
   * Unlike `ReadStream`, this never waits. `done` reports whether the stream
   * is closed: `done: false` with `hasMore: false` means nothing is
   * available right now, but more chunks may still arrive.
   *
   * Throws: BadRequestError, InternalError, RunNotFoundError,
   * StreamExpiredError, StreamNotFoundError, ThrottledError.
   */
  listStreamChunks(input: ListStreamChunksInput): Promise<ListStreamChunksOutput>;

  /**
   * Lists the stream names belonging to a run.
   *
   * Throws: ExpiredError, InternalError, RunNotFoundError, ThrottledError.
   */
  listStreams(input: ListStreamsInput): Promise<ListStreamsOutput>;

  /**
   * Reads a stream live, waiting for chunks until the stream closes.
   *
   * A positive `startIndex` skips that many chunks from the start. A
   * negative one starts that many chunks before the current end, clamped to
   * zero.
   *
   * Throws: InternalError, RunNotFoundError, StreamExpiredError,
   * StreamNotFoundError, ThrottledError.
   */
  readStream(input: ReadStreamInput): Promise<ReadStreamOutput>;

  /**
   * Appends one chunk to a stream.
   *
   * Throws: ConflictError, InternalError, RunNotFoundError,
   * StreamExpiredError, ThrottledError.
   */
  writeStreamChunk(input: WriteStreamChunkInput): Promise<WriteStreamChunkOutput>;
}

/**
 * Operations that are resolved in-process and never exposed over a
 * transport. See the `localOnly` trait.
 */
export interface WorldLocalHooksPort {
  /**
   * Mints a new run ID.
   *
   * Returns the bare ULID; the core attaches the `wrun_` prefix.
   * Implementations may embed world-specific metadata such as a region as
   * long as the result stays a valid ULID.
   *
   * Local only: never exposed over a transport.
   */
  createRunId(input: CreateRunIdInput): Promise<CreateRunIdOutput>;

  /**
   * Returns extra display fields for a run.
   *
   * Called once per displayed run by tooling, so it must be cheap, pure, and
   * non-throwing.
   *
   * Local only: never exposed over a transport.
   */
  describeRun(input: DescribeRunInput): Promise<DescribeRunOutput>;

  /**
   * Resolves the AES-256 key for a run.
   *
   * Local only, permanently: key material must never cross a transport
   * boundary. It is modeled here so in-process implementations share one
   * contract across languages, and every transport projection is expected to
   * drop it. Absent support means encryption is disabled.
   *
   * Local only: never exposed over a transport.
   */
  getEncryptionKeyForRun(input: GetEncryptionKeyForRunInput): Promise<GetEncryptionKeyForRunOutput>;

  /**
   * Returns the environment this World's writes are attributed to.
   *
   * Must match the attribution the backend will actually apply. Callers use
   * it to detect cross-environment mismatches, so a plausible-looking wrong
   * value is worse than none.
   *
   * Local only: never exposed over a transport.
   */
  getEnvironment(input: GetEnvironmentInput): Promise<GetEnvironmentOutput>;

  /**
   * Returns the wall-clock time at which the current invocation will be
   * terminated by the hosting platform, when that is known.
   *
   * Local only: never exposed over a transport.
   */
  getRuntimeDeadline(input: GetRuntimeDeadlineInput): Promise<GetRuntimeDeadlineOutput>;
}
