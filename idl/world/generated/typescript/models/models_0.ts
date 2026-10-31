// smithy-typescript generated code
import type { DocumentType as __DocumentType, StreamingBlobTypes } from "@smithy/types";

import type { ResolveData, RunStatus, SortOrder, StepStatus } from "./enums";

/**
 * @public
 */
export interface AlreadyCancelledOutcome {}

/**
 * Removal of an attribute key.
 *
 * An empty structure rather than `Unit` so the variant can gain members
 * later without a breaking change.
 * @public
 */
export interface RemoveAttribute {}

/**
 * Upsert or removal of one attribute key.
 * @public
 */
export type AttributeChangeValue =
  | AttributeChangeValue.RemoveMember
  | AttributeChangeValue.SetMember
  | AttributeChangeValue.$UnknownMember;

/**
 * @public
 */
export namespace AttributeChangeValue {
  /**
   * Upsert the key with this value.
   * @public
   */
  export interface SetMember {
    set: string;
    remove?: never;
    $unknown?: never;
  }

  /**
   * Remove the key.
   * @public
   */
  export interface RemoveMember {
    set?: never;
    remove: RemoveAttribute;
    $unknown?: never;
  }

  /**
   * @public
   */
  export interface $UnknownMember {
    set?: never;
    remove?: never;
    $unknown: [string, any];
  }

  /**
   * @deprecated unused in schema-serde mode.
   *
   */
  export interface Visitor<T> {
    set: (value: string) => T;
    remove: (value: RemoveAttribute) => T;
    _: (name: string, value: any) => T;
  }
}

/**
 * A single attribute mutation. Keys absent from a change set are untouched.
 * @public
 */
export interface AttributeChange {
  key: string | undefined;
  /**
   * Upsert or removal of one attribute key.
   * @public
   */
  change: AttributeChangeValue | undefined;
}

/**
 * @public
 */
export interface StepAttributeWriter {
  /**
   * Identifier of a step within a run.
   * @public
   */
  stepId: string | undefined;

  attempt: number | undefined;
}

/**
 * The workflow function itself wrote the attributes.
 * @public
 */
export interface WorkflowAttributeWriter {}

/**
 * Identifies which writer produced an attribute change.
 * @public
 */
export type AttributeWriter =
  | AttributeWriter.StepMember
  | AttributeWriter.WorkflowMember
  | AttributeWriter.$UnknownMember;

/**
 * @public
 */
export namespace AttributeWriter {
  /**
   * The workflow function itself wrote the attributes.
   * @public
   */
  export interface WorkflowMember {
    workflow: WorkflowAttributeWriter;
    step?: never;
    $unknown?: never;
  }

  export interface StepMember {
    workflow?: never;
    step: StepAttributeWriter;
    $unknown?: never;
  }

  /**
   * @public
   */
  export interface $UnknownMember {
    workflow?: never;
    step?: never;
    $unknown: [string, any];
  }

  /**
   * @deprecated unused in schema-serde mode.
   *
   */
  export interface Visitor<T> {
    workflow: (value: WorkflowAttributeWriter) => T;
    step: (value: StepAttributeWriter) => T;
    _: (name: string, value: any) => T;
  }
}

/**
 * Merges plaintext attribute changes into the run.
 * @public
 */
export interface AttributesSetEvent {
  changes: AttributeChange[] | undefined;
  /**
   * Identifies which writer produced an attribute change.
   * @public
   */
  writer: AttributeWriter | undefined;

  /**
   * Permits keys in the reserved `$` namespace. Framework callers only.
   * @public
   */
  allowReservedAttributes?: boolean | undefined;
}

/**
 * @public
 */
export interface BatchGetRunsInput {
  runIds: string[] | undefined;
  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * Materialized view of a run.
 *
 * `input`, `output`, and `error` are absent when the caller asked for
 * `ResolveData$NONE`, and `output`/`error`/`completedAt` are only populated
 * once the run reaches the matching terminal status.
 * @public
 */
export interface WorkflowRun {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Lifecycle status of a run.
   * @public
   */
  status: RunStatus | undefined;

  /**
   * Identifier of a deployment a run is pinned to.
   * @public
   */
  deploymentId: string | undefined;

  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName: string | undefined;

  /**
   * Workflow protocol spec version the run was created under.
   * @public
   */
  specVersion?: number | undefined;

  /**
   * Opaque, world-specific execution context recorded at creation.
   * @public
   */
  executionContext?: __DocumentType | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input?: Uint8Array | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  output?: Uint8Array | undefined;

  /**
   * Serialized thrown value from `run_failed`.
   * @public
   */
  error?: Uint8Array | undefined;

  /**
   * Plaintext failure category, readable without decryption.
   * @public
   */
  errorCode?: string | undefined;

  /**
   * Plaintext run attributes.
   * @public
   */
  attributes: Record<string, string> | undefined;

  /**
   * Base64 X25519 public key that lets other parties seal payloads to this
   * run. Present only for runs created by SDKs that support sealed
   * envelopes on encryption-capable implementations.
   * @public
   */
  encryptionPublicKey?: string | undefined;

  expiredAt?: Date | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
}

/**
 * @public
 */
export interface BatchGetRunsOutput {
  runs: (WorkflowRun | null)[] | undefined;
}

/**
 * @public
 */
export interface BulkCancelFailure {
  code: string | undefined;
  retryable: boolean | undefined;
}

/**
 * @public
 */
export interface CancelledOutcome {}

/**
 * @public
 */
export interface NotCancellableOutcome {
  /**
   * Observed run status.
   * @public
   */
  status: RunStatus | undefined;
}

/**
 * @public
 */
export interface RunNotFoundOutcome {}

/**
 * Per-run outcome of a bulk cancellation.
 * @public
 */
export type BulkCancelOutcome =
  | BulkCancelOutcome.AlreadyCancelledMember
  | BulkCancelOutcome.CancelledMember
  | BulkCancelOutcome.FailedMember
  | BulkCancelOutcome.NotCancellableMember
  | BulkCancelOutcome.NotFoundMember
  | BulkCancelOutcome.$UnknownMember;

/**
 * @public
 */
export namespace BulkCancelOutcome {
  /**
   * This request transitioned the run to cancelled.
   * @public
   */
  export interface CancelledMember {
    cancelled: CancelledOutcome;
    alreadyCancelled?: never;
    notCancellable?: never;
    notFound?: never;
    failed?: never;
    $unknown?: never;
  }

  /**
   * The run was already cancelled. Idempotent success.
   * @public
   */
  export interface AlreadyCancelledMember {
    cancelled?: never;
    alreadyCancelled: AlreadyCancelledOutcome;
    notCancellable?: never;
    notFound?: never;
    failed?: never;
    $unknown?: never;
  }

  /**
   * The run is in a terminal, non-cancellable state.
   * @public
   */
  export interface NotCancellableMember {
    cancelled?: never;
    alreadyCancelled?: never;
    notCancellable: NotCancellableOutcome;
    notFound?: never;
    failed?: never;
    $unknown?: never;
  }

  /**
   * No run exists for this ID.
   * @public
   */
  export interface NotFoundMember {
    cancelled?: never;
    alreadyCancelled?: never;
    notCancellable?: never;
    notFound: RunNotFoundOutcome;
    failed?: never;
    $unknown?: never;
  }

  /**
   * Cancellation failed for this run.
   * @public
   */
  export interface FailedMember {
    cancelled?: never;
    alreadyCancelled?: never;
    notCancellable?: never;
    notFound?: never;
    failed: BulkCancelFailure;
    $unknown?: never;
  }

  /**
   * @public
   */
  export interface $UnknownMember {
    cancelled?: never;
    alreadyCancelled?: never;
    notCancellable?: never;
    notFound?: never;
    failed?: never;
    $unknown: [string, any];
  }

  /**
   * @deprecated unused in schema-serde mode.
   *
   */
  export interface Visitor<T> {
    cancelled: (value: CancelledOutcome) => T;
    alreadyCancelled: (value: AlreadyCancelledOutcome) => T;
    notCancellable: (value: NotCancellableOutcome) => T;
    notFound: (value: RunNotFoundOutcome) => T;
    failed: (value: BulkCancelFailure) => T;
    _: (name: string, value: any) => T;
  }
}

/**
 * @public
 */
export interface BulkCancelResult {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Per-run outcome of a bulk cancellation.
   * @public
   */
  outcome: BulkCancelOutcome | undefined;
}

/**
 * @public
 */
export interface BulkCancelRunsInput {
  /**
   * 1-500 unique run IDs.
   * @public
   */
  runIds: string[] | undefined;

  cancelReason?: string | undefined;
}

/**
 * @public
 */
export interface BulkCancelSummary {
  requested: number | undefined;
  cancelled: number | undefined;
  alreadyCancelled: number | undefined;
  notCancellable: number | undefined;
  notFound: number | undefined;
  failed: number | undefined;
}

/**
 * @public
 */
export interface BulkCancelRunsOutput {
  summary: BulkCancelSummary | undefined;
  /**
   * One entry per requested ID, in request order.
   * @public
   */
  results: BulkCancelResult[] | undefined;
}

/**
 * Marks an operation that is invoked in the reverse direction: the World (or
 * its queue adapter) calls the workflow runtime rather than the other way
 * around.
 * @public
 */
export interface Callback {}

/**
 * @public
 */
export interface CloseStreamInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;
}

/**
 * @public
 */
export interface CloseStreamOutput {}

/**
 * Creates a hook and claims its token.
 * @public
 */
export interface HookCreatedEvent {
  token: string | undefined;
  /**
   * Requests minimum token retention past the run's end. Requires the
   * `hookRetention` capability.
   * @public
   */
  tokenRetentionUntil?: Date | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  metadata?: Uint8Array | undefined;

  isWebhook?: boolean | undefined;
  isSystem?: boolean | undefined;
}

/**
 * Disposes a hook and releases its token immediately.
 * @public
 */
export interface HookDisposedEvent {
  token?: string | undefined;
}

/**
 * Delivers a payload to an active hook.
 * @public
 */
export interface HookReceivedEvent {
  token?: string | undefined;
  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  payload: Uint8Array | undefined;
}

/**
 * Transitions a run to `cancelled`.
 * @public
 */
export interface RunCancelledEvent {
  cancelReason?: string | undefined;
}

/**
 * Transitions a run to `completed`.
 * @public
 */
export interface RunCompletedEvent {
  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  output?: Uint8Array | undefined;
}

/**
 * Transitions a run to `failed`.
 * @public
 */
export interface RunFailedEvent {
  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  error: Uint8Array | undefined;

  /**
   * Plaintext failure category kept readable without decryption.
   * @public
   */
  errorCode?: string | undefined;
}

/**
 * Transitions a run to `running`.
 *
 * The optional creation fields carry the resilient-start path: when the
 * `run_created` write did not commit, the implementation creates the run
 * from this event instead.
 * @public
 */
export interface RunStartedEvent {
  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input?: Uint8Array | undefined;

  /**
   * Identifier of a deployment a run is pinned to.
   * @public
   */
  deploymentId?: string | undefined;

  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName?: string | undefined;

  executionContext?: __DocumentType | undefined;
  /**
   * Plaintext run attributes.
   * @public
   */
  attributes?: Record<string, string> | undefined;

  allowReservedAttributes?: boolean | undefined;
  encryptionPublicKey?: string | undefined;
}

/**
 * Client-measured latency telemetry carried on a step's terminal event.
 *
 * Populated only on the terminal event of a qualifying first-attempt step
 * execution. Implementations may consume these for metrics and are never
 * required to persist them.
 * @public
 */
export interface StepLatencyTelemetry {
  /**
   * Milliseconds from run creation until the run's first step body began.
   * @public
   */
  ttfs?: number | undefined;

  /**
   * Milliseconds between the previous step's terminal event and this
   * step's body beginning.
   * @public
   */
  stso?: number | undefined;

  /**
   * Step count when the step-to-step gap began.
   * @public
   */
  stepCount?: number | undefined;

  /**
   * Event count when the step-to-step gap began.
   * @public
   */
  eventCount?: number | undefined;

  /**
   * Milliseconds from `run_started` landing until this step's start was
   * issued. A sub-window of `ttfs`.
   * @public
   */
  rsfs?: number | undefined;

  /**
   * Synchronous replay duration of the final scheduling pass within the
   * `rsfs` window.
   * @public
   */
  finalSchedulingReplay?: number | undefined;

  /**
   * Names of the runtime startup optimizations active for this
   * measurement, e.g. `turbo` or `lazyStepStart`.
   * @public
   */
  optimizations?: string[] | undefined;
}

/**
 * Completes a step successfully.
 * @public
 */
export interface StepCompletedEvent {
  /**
   * Machine-readable step function name.
   * @public
   */
  stepName?: string | undefined;

  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName?: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  result: Uint8Array | undefined;

  /**
   * Client-measured latency telemetry carried on a step's terminal event.
   *
   * Populated only on the terminal event of a qualifying first-attempt step
   * execution. Implementations may consume these for metrics and are never
   * required to persist them.
   * @public
   */
  telemetry?: StepLatencyTelemetry | undefined;
}

/**
 * Creates a step entity.
 * @public
 */
export interface StepCreatedEvent {
  /**
   * Machine-readable step function name.
   * @public
   */
  stepName: string | undefined;

  /**
   * Carried so a backend keying payload refs by workflow name avoids a run
   * lookup on this hot write.
   * @public
   */
  workflowName?: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input: Uint8Array | undefined;
}

/**
 * Fails a step terminally.
 * @public
 */
export interface StepFailedEvent {
  /**
   * Machine-readable step function name.
   * @public
   */
  stepName?: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  error: Uint8Array | undefined;

  /**
   * Client-measured latency telemetry carried on a step's terminal event.
   *
   * Populated only on the terminal event of a qualifying first-attempt step
   * execution. Implementations may consume these for metrics and are never
   * required to persist them.
   * @public
   */
  telemetry?: StepLatencyTelemetry | undefined;
}

/**
 * Returns a failed step to `pending` for another attempt.
 * @public
 */
export interface StepRetryingEvent {
  /**
   * Machine-readable step function name.
   * @public
   */
  stepName?: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  error: Uint8Array | undefined;

  retryAfter?: Date | undefined;
}

/**
 * Begins a step attempt, transitioning the step to `running`.
 *
 * When `stepName` and `input` are present, this is the lazy-start path: the
 * implementation atomically creates the step (writing a synthetic
 * `step_created` so replay still observes it) before starting it. Without
 * `input`, a prior `step_created` is required.
 * @public
 */
export interface StepStartedEvent {
  /**
   * Machine-readable step function name.
   * @public
   */
  stepName?: string | undefined;

  attempt?: number | undefined;
  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName?: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input?: Uint8Array | undefined;

  /**
   * Queue message ID of the invocation executing this step inline. Doubles
   * as the ownership liveness lease, so it requires a queue whose message
   * ID is stable across redeliveries.
   * @public
   */
  ownerMessageId?: string | undefined;
}

/**
 * Completes a wait. Intended to be atomic and exactly once.
 * @public
 */
export interface WaitCompletedEvent {
  resumeAt?: Date | undefined;
}

/**
 * Creates a wait that resumes at a wall-clock time.
 * @public
 */
export interface WaitCreatedEvent {
  resumeAt: Date | undefined;
}

/**
 * Every event a caller may write to an existing run.
 *
 * `run_created` is absent because it creates the run and is modeled as
 * `CreateRun`. `hook_conflict` is absent because only implementations
 * produce it.
 * @public
 */
export type CreatableEvent =
  | CreatableEvent.AttributesSetMember
  | CreatableEvent.HookCreatedMember
  | CreatableEvent.HookDisposedMember
  | CreatableEvent.HookReceivedMember
  | CreatableEvent.RunCancelledMember
  | CreatableEvent.RunCompletedMember
  | CreatableEvent.RunFailedMember
  | CreatableEvent.RunStartedMember
  | CreatableEvent.StepCompletedMember
  | CreatableEvent.StepCreatedMember
  | CreatableEvent.StepFailedMember
  | CreatableEvent.StepRetryingMember
  | CreatableEvent.StepStartedMember
  | CreatableEvent.WaitCompletedMember
  | CreatableEvent.WaitCreatedMember
  | CreatableEvent.$UnknownMember;

/**
 * @public
 */
export namespace CreatableEvent {
  /**
   * Transitions a run to `running`.
   *
   * The optional creation fields carry the resilient-start path: when the
   * `run_created` write did not commit, the implementation creates the run
   * from this event instead.
   * @public
   */
  export interface RunStartedMember {
    runStarted: RunStartedEvent;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `completed`.
   * @public
   */
  export interface RunCompletedMember {
    runStarted?: never;
    runCompleted: RunCompletedEvent;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `failed`.
   * @public
   */
  export interface RunFailedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed: RunFailedEvent;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `cancelled`.
   * @public
   */
  export interface RunCancelledMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled: RunCancelledEvent;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Merges plaintext attribute changes into the run.
   * @public
   */
  export interface AttributesSetMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet: AttributesSetEvent;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a step entity.
   * @public
   */
  export interface StepCreatedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated: StepCreatedEvent;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Begins a step attempt, transitioning the step to `running`.
   *
   * When `stepName` and `input` are present, this is the lazy-start path: the
   * implementation atomically creates the step (writing a synthetic
   * `step_created` so replay still observes it) before starting it. Without
   * `input`, a prior `step_created` is required.
   * @public
   */
  export interface StepStartedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted: StepStartedEvent;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Completes a step successfully.
   * @public
   */
  export interface StepCompletedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted: StepCompletedEvent;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Fails a step terminally.
   * @public
   */
  export interface StepFailedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed: StepFailedEvent;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Returns a failed step to `pending` for another attempt.
   * @public
   */
  export interface StepRetryingMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying: StepRetryingEvent;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a hook and claims its token.
   * @public
   */
  export interface HookCreatedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated: HookCreatedEvent;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Delivers a payload to an active hook.
   * @public
   */
  export interface HookReceivedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived: HookReceivedEvent;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Disposes a hook and releases its token immediately.
   * @public
   */
  export interface HookDisposedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed: HookDisposedEvent;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a wait that resumes at a wall-clock time.
   * @public
   */
  export interface WaitCreatedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated: WaitCreatedEvent;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Completes a wait. Intended to be atomic and exactly once.
   * @public
   */
  export interface WaitCompletedMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted: WaitCompletedEvent;
    $unknown?: never;
  }

  /**
   * @public
   */
  export interface $UnknownMember {
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown: [string, any];
  }

  /**
   * @deprecated unused in schema-serde mode.
   *
   */
  export interface Visitor<T> {
    runStarted: (value: RunStartedEvent) => T;
    runCompleted: (value: RunCompletedEvent) => T;
    runFailed: (value: RunFailedEvent) => T;
    runCancelled: (value: RunCancelledEvent) => T;
    attributesSet: (value: AttributesSetEvent) => T;
    stepCreated: (value: StepCreatedEvent) => T;
    stepStarted: (value: StepStartedEvent) => T;
    stepCompleted: (value: StepCompletedEvent) => T;
    stepFailed: (value: StepFailedEvent) => T;
    stepRetrying: (value: StepRetryingEvent) => T;
    hookCreated: (value: HookCreatedEvent) => T;
    hookReceived: (value: HookReceivedEvent) => T;
    hookDisposed: (value: HookDisposedEvent) => T;
    waitCreated: (value: WaitCreatedEvent) => T;
    waitCompleted: (value: WaitCompletedEvent) => T;
    _: (name: string, value: any) => T;
  }
}

/**
 * Advisory and idempotency parameters for an event write.
 *
 * Everything here is optional. An implementation that ignores all of it
 * stays correct; the runtime falls back to explicit reads.
 * @public
 */
export interface CreateEventOptions {
  /**
   * Legacy spec-version-1 compatibility mode.
   * @public
   */
  v1Compat?: boolean | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  /**
   * Lazy hook resume idempotency key. The implementation routes it to a
   * `(runId, resumeId)` constraint so a producer's direct write and the
   * queue consumer's re-ensure converge on exactly one event. Only
   * meaningful for `hookReceived`.
   * @public
   */
  resumeId?: string | undefined;

  /**
   * Digest of the serialized resume payload, sent identically by both
   * writers of a deduplicated resume.
   * @public
   */
  resumePayloadDigest?: string | undefined;

  /**
   * Marks a `stepCreated` write as the queue consumer's re-ensure of a
   * resilient step dispatch.
   * @public
   */
  viaStepDispatch?: boolean | undefined;

  /**
   * Platform request ID, for correlating logs with events.
   * @public
   */
  requestId?: string | undefined;

  /**
   * Compute instance whose handler is writing this event.
   * @public
   */
  computeInstanceId?: string | undefined;

  /**
   * How many events the writer held when it decided to write this one.
   *
   * Only meaningful against an implementation advertising `slotEventIds`,
   * where slots are dense and 1-based. Contention never rejects the write:
   * the implementation bumps to the next free slot, commits, and returns
   * the skipped events on the response. Understating is safe; overstating
   * hides events from the writer.
   * @public
   */
  eventCount?: number | undefined;

  /**
   * Client-side occurrence time, stored separately from the accept time.
   * @public
   */
  occurredAt?: Date | undefined;

  /**
   * Telemetry only: consecutive replay divergences resolved by this write.
   * Never persisted into the log.
   * @public
   */
  replayDivergenceCount?: number | undefined;

  /**
   * Inline-delta opt-in. The implementation may return the events written
   * strictly after this cursor, matching `ListEvents` semantics.
   * @public
   */
  sinceCursor?: string | undefined;

  /**
   * Asks the implementation to skip the `runStarted` preload it would
   * otherwise compute. Honored only for `runStarted`.
   * @public
   */
  skipPreload?: boolean | undefined;

  /**
   * Asks for the run's full replay log alongside a `hookReceived`
   * re-ensure. The runtime trusts it only when the log is complete,
   * `hasMore` is false, and the run and event ceiling are present.
   * @public
   */
  preloadEvents?: boolean | undefined;
}

/**
 * @public
 */
export interface CreateEventInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Every event a caller may write to an existing run.
   *
   * `run_created` is absent because it creates the run and is modeled as
   * `CreateRun`. `hook_conflict` is absent because only implementations
   * produce it.
   * @public
   */
  event: CreatableEvent | undefined;

  /**
   * Advisory and idempotency parameters for an event write.
   *
   * Everything here is optional. An implementation that ignores all of it
   * stays correct; the runtime falls back to explicit reads.
   * @public
   */
  options?: CreateEventOptions | undefined;
}

/**
 * Records that a `hook_created` lost a token race.
 *
 * Implementations write this; callers cannot. Consumers reject the awaited
 * hook with a token-conflict error.
 * @public
 */
export interface HookConflictEvent {
  token: string | undefined;
  /**
   * Run that currently owns the token.
   * @public
   */
  conflictingRunId?: string | undefined;
}

/**
 * Starts a new run. Materializes the run entity with status `pending`.
 * @public
 */
export interface RunCreatedEvent {
  /**
   * Identifier of a deployment a run is pinned to.
   * @public
   */
  deploymentId: string | undefined;

  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName: string | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input: Uint8Array | undefined;

  executionContext?: __DocumentType | undefined;
  /**
   * Plaintext run attributes.
   * @public
   */
  attributes?: Record<string, string> | undefined;

  allowReservedAttributes?: boolean | undefined;
  /**
   * Base64 X25519 public key, stamped by SDKs that support sealed
   * envelopes.
   * @public
   */
  encryptionPublicKey?: string | undefined;
}

/**
 * Every event readable from a run's log.
 * @public
 */
export type EventPayload =
  | EventPayload.AttributesSetMember
  | EventPayload.HookConflictMember
  | EventPayload.HookCreatedMember
  | EventPayload.HookDisposedMember
  | EventPayload.HookReceivedMember
  | EventPayload.RunCancelledMember
  | EventPayload.RunCompletedMember
  | EventPayload.RunCreatedMember
  | EventPayload.RunFailedMember
  | EventPayload.RunStartedMember
  | EventPayload.StepCompletedMember
  | EventPayload.StepCreatedMember
  | EventPayload.StepFailedMember
  | EventPayload.StepRetryingMember
  | EventPayload.StepStartedMember
  | EventPayload.WaitCompletedMember
  | EventPayload.WaitCreatedMember
  | EventPayload.$UnknownMember;

/**
 * @public
 */
export namespace EventPayload {
  /**
   * Starts a new run. Materializes the run entity with status `pending`.
   * @public
   */
  export interface RunCreatedMember {
    runCreated: RunCreatedEvent;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `running`.
   *
   * The optional creation fields carry the resilient-start path: when the
   * `run_created` write did not commit, the implementation creates the run
   * from this event instead.
   * @public
   */
  export interface RunStartedMember {
    runCreated?: never;
    runStarted: RunStartedEvent;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `completed`.
   * @public
   */
  export interface RunCompletedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted: RunCompletedEvent;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `failed`.
   * @public
   */
  export interface RunFailedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed: RunFailedEvent;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Transitions a run to `cancelled`.
   * @public
   */
  export interface RunCancelledMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled: RunCancelledEvent;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Merges plaintext attribute changes into the run.
   * @public
   */
  export interface AttributesSetMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet: AttributesSetEvent;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a step entity.
   * @public
   */
  export interface StepCreatedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated: StepCreatedEvent;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Begins a step attempt, transitioning the step to `running`.
   *
   * When `stepName` and `input` are present, this is the lazy-start path: the
   * implementation atomically creates the step (writing a synthetic
   * `step_created` so replay still observes it) before starting it. Without
   * `input`, a prior `step_created` is required.
   * @public
   */
  export interface StepStartedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted: StepStartedEvent;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Completes a step successfully.
   * @public
   */
  export interface StepCompletedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted: StepCompletedEvent;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Fails a step terminally.
   * @public
   */
  export interface StepFailedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed: StepFailedEvent;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Returns a failed step to `pending` for another attempt.
   * @public
   */
  export interface StepRetryingMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying: StepRetryingEvent;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a hook and claims its token.
   * @public
   */
  export interface HookCreatedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated: HookCreatedEvent;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Delivers a payload to an active hook.
   * @public
   */
  export interface HookReceivedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived: HookReceivedEvent;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Disposes a hook and releases its token immediately.
   * @public
   */
  export interface HookDisposedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed: HookDisposedEvent;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Records that a `hook_created` lost a token race.
   *
   * Implementations write this; callers cannot. Consumers reject the awaited
   * hook with a token-conflict error.
   * @public
   */
  export interface HookConflictMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict: HookConflictEvent;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Creates a wait that resumes at a wall-clock time.
   * @public
   */
  export interface WaitCreatedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated: WaitCreatedEvent;
    waitCompleted?: never;
    $unknown?: never;
  }

  /**
   * Completes a wait. Intended to be atomic and exactly once.
   * @public
   */
  export interface WaitCompletedMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted: WaitCompletedEvent;
    $unknown?: never;
  }

  /**
   * @public
   */
  export interface $UnknownMember {
    runCreated?: never;
    runStarted?: never;
    runCompleted?: never;
    runFailed?: never;
    runCancelled?: never;
    attributesSet?: never;
    stepCreated?: never;
    stepStarted?: never;
    stepCompleted?: never;
    stepFailed?: never;
    stepRetrying?: never;
    hookCreated?: never;
    hookReceived?: never;
    hookDisposed?: never;
    hookConflict?: never;
    waitCreated?: never;
    waitCompleted?: never;
    $unknown: [string, any];
  }

  /**
   * @deprecated unused in schema-serde mode.
   *
   */
  export interface Visitor<T> {
    runCreated: (value: RunCreatedEvent) => T;
    runStarted: (value: RunStartedEvent) => T;
    runCompleted: (value: RunCompletedEvent) => T;
    runFailed: (value: RunFailedEvent) => T;
    runCancelled: (value: RunCancelledEvent) => T;
    attributesSet: (value: AttributesSetEvent) => T;
    stepCreated: (value: StepCreatedEvent) => T;
    stepStarted: (value: StepStartedEvent) => T;
    stepCompleted: (value: StepCompletedEvent) => T;
    stepFailed: (value: StepFailedEvent) => T;
    stepRetrying: (value: StepRetryingEvent) => T;
    hookCreated: (value: HookCreatedEvent) => T;
    hookReceived: (value: HookReceivedEvent) => T;
    hookDisposed: (value: HookDisposedEvent) => T;
    hookConflict: (value: HookConflictEvent) => T;
    waitCreated: (value: WaitCreatedEvent) => T;
    waitCompleted: (value: WaitCompletedEvent) => T;
    _: (name: string, value: any) => T;
  }
}

/**
 * One committed entry in a run's event log.
 * @public
 */
export interface Event {
  /**
   * Identifier of an event within a run's log.
   * @public
   */
  eventId: string | undefined;

  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Entity this event affects. Absent on run-level events.
   * @public
   */
  correlationId?: string | undefined;

  /**
   * Every event readable from a run's log.
   * @public
   */
  payload: EventPayload | undefined;

  specVersion?: number | undefined;
  /**
   * When the implementation accepted the event.
   * @public
   */
  createdAt: Date | undefined;

  /**
   * When the client observed the event, when it reported one.
   * @public
   */
  occurredAt?: Date | undefined;

  /**
   * Idempotency key persisted on a lazy `hook_received`.
   * @public
   */
  resumeId?: string | undefined;
}

/**
 * Backend-attested resume capabilities, recomputed on every by-token lookup.
 *
 * Response-only and never persisted, so a rollback or kill switch downgrades
 * new resumes immediately by omitting it.
 * @public
 */
export interface HookResumeCapabilities {
  /**
   * Present when the live backend enforces the `(runId, resumeId)` dedup
   * constraint.
   * @public
   */
  hookResumeDedupVersion: number | undefined;
}

/**
 * Immutable slice of a hook's owning run, sufficient to resume the hook
 * without reading the run entity.
 *
 * Deliberately excludes mutable run state, payloads, attributes, and any
 * secret.
 * @public
 */
export interface HookResumeContext {
  /**
   * Identifier of a deployment a run is pinned to.
   * @public
   */
  deploymentId: string | undefined;

  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName: string | undefined;

  /**
   * Spec version of the owning run, distinct from the hook's own.
   * @public
   */
  runSpecVersion?: number | undefined;

  workflowCoreVersion?: string | undefined;
  /**
   * W3C trace context propagated from hook creation.
   * @public
   */
  traceCarrier?: Record<string, string> | undefined;

  /**
   * The run's base64 X25519 public key, mirrored from the run entity.
   * @public
   */
  encryptionPublicKey?: string | undefined;

  /**
   * Version of the lazy-hook-resume consumer protocol supported by the
   * run's creating deployment. Absent means the sequential path.
   * @public
   */
  hookResumeInputVersion?: number | undefined;
}

/**
 * Materialized view of a hook.
 *
 * A hook kept alive by minimum retention stays readable after its run ends
 * and continues to reserve its token, but can no longer be resumed.
 * @public
 */
export interface Hook {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Identifier of a hook.
   * @public
   */
  hookId: string | undefined;

  token: string | undefined;
  ownerId: string | undefined;
  projectId: string | undefined;
  environment: string | undefined;
  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  metadata?: Uint8Array | undefined;

  specVersion?: number | undefined;
  isWebhook?: boolean | undefined;
  isSystem?: boolean | undefined;
  /**
   * Earliest time the token may be released after the run ends. An active
   * run holds the token past this deadline.
   * @public
   */
  tokenRetentionUntil?: Date | undefined;

  /**
   * Immutable slice of a hook's owning run, sufficient to resume the hook
   * without reading the run entity.
   *
   * Deliberately excludes mutable run state, payloads, attributes, and any
   * secret.
   * @public
   */
  resumeContext?: HookResumeContext | undefined;

  /**
   * Backend-attested resume capabilities, recomputed on every by-token lookup.
   *
   * Response-only and never persisted, so a rollback or kill switch downgrades
   * new resumes immediately by omitting it.
   * @public
   */
  resumeCapabilities?: HookResumeCapabilities | undefined;

  createdAt: Date | undefined;
}

/**
 * Materialized view of a step.
 * @public
 */
export interface Step {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Identifier of a step within a run.
   * @public
   */
  stepId: string | undefined;

  /**
   * Machine-readable step function name.
   * @public
   */
  stepName: string | undefined;

  /**
   * Lifecycle status of a step.
   * @public
   */
  status: StepStatus | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  input?: Uint8Array | undefined;

  /**
   * Opaque serialized workflow data.
   *
   * Payload bytes are produced by the SDK serialization pipeline and may be
   * compressed and/or encrypted. The World never interprets them. Runs created
   * by spec version 1 carried unserialized JSON instead; those records are not
   * representable here and must be converted by a compatibility adapter.
   * @public
   */
  output?: Uint8Array | undefined;

  /**
   * Most recent serialized thrown value, from either a retry or the final
   * failure.
   * @public
   */
  error?: Uint8Array | undefined;

  attempt: number | undefined;
  /**
   * When the step first began executing. Not updated by retries.
   * @public
   */
  startedAt?: Date | undefined;

  completedAt?: Date | undefined;
  /**
   * Earliest time a retrying step may start again.
   * @public
   */
  retryAfter?: Date | undefined;

  specVersion?: number | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
}

/**
 * Materialized view of a wait.
 * @public
 */
export interface Wait {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Identifier of a wait.
   * @public
   */
  waitId: string | undefined;

  resumeAt: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date | undefined;
}

/**
 * Result of an event write.
 *
 * The event and the entity it affects are materialized atomically. The
 * delta members are populated when the caller opted into an inline delta or
 * preload, and by a slot-numbering implementation reporting the slots it
 * bumped past.
 * @public
 */
export interface EventMutationResult {
  /**
   * The committed event. Absent only for legacy runs that skip event
   * storage.
   * @public
   */
  event?: Event | undefined;

  /**
   * Materialized view of a run.
   *
   * `input`, `output`, and `error` are absent when the caller asked for
   * `ResolveData$NONE`, and `output`/`error`/`completedAt` are only populated
   * once the run reaches the matching terminal status.
   * @public
   */
  run?: WorkflowRun | undefined;

  /**
   * Materialized view of a step.
   * @public
   */
  step?: Step | undefined;

  /**
   * Materialized view of a hook.
   *
   * A hook kept alive by minimum retention stays readable after its run ends
   * and continues to reserve its token, but can no longer be resumed.
   * @public
   */
  hook?: Hook | undefined;

  /**
   * Materialized view of a wait.
   * @public
   */
  wait?: Wait | undefined;

  /**
   * True only when a lazy `stepStarted` created the step on this call.
   * The caller that sees it owns inline execution of that step.
   * @public
   */
  stepCreated?: boolean | undefined;

  /**
   * Server-owned event ceiling for the run, enforced by the runtime.
   * @public
   */
  maxEvents?: number | undefined;

  /**
   * Events the caller had not seen, in log order.
   * @public
   */
  events?: Event[] | undefined;

  /**
   * Cursor past the last returned event.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Whether more event pages follow `events`.
   * @public
   */
  hasMore?: boolean | undefined;
}

/**
 * @public
 */
export interface CreateRunInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Starts a new run. Materializes the run entity with status `pending`.
   * @public
   */
  event: RunCreatedEvent | undefined;

  /**
   * Advisory and idempotency parameters for an event write.
   *
   * Everything here is optional. An implementation that ignores all of it
   * stays correct; the runtime falls back to explicit reads.
   * @public
   */
  options?: CreateEventOptions | undefined;
}

/**
 * @public
 */
export interface CreateRunIdInput {
  /**
   * The full options bag passed to `start()`. Implementations read
   * only the keys they recognize and ignore the rest.
   * @public
   */
  options?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface CreateRunIdOutput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;
}

/**
 * @public
 */
export interface DeliverQueueMessageInput {
  /**
   * Logical queue name, e.g. a flow or step topic.
   * @public
   */
  queueName: string | undefined;

  /**
   * Opaque queue payload.
   *
   * The runtime's invoke and health-check payload schemas are deliberately not
   * modeled yet: they are producer-and-consumer-private, versioned by run spec
   * version, and encoded as CBOR or JSON depending on that version. Modeling
   * them belongs in a follow-up once the transport story is settled.
   * @public
   */
  message: Uint8Array | undefined;

  /**
   * 1-based delivery attempt.
   * @public
   */
  attempt: number | undefined;

  /**
   * Queue message identifier.
   *
   * Should be stable across redeliveries of one enqueued message: the
   * runtime's inline step ownership uses it as a liveness lease. An
   * implementation that mints a fresh ID per delivery still works, but owner
   * redeliveries fall back to the slower backstop path.
   * @public
   */
  messageId: string | undefined;

  requestId?: string | undefined;
}

/**
 * Instructs the caller to redeliver the message later.
 * @public
 */
export interface RetryDirective {
  timeoutSeconds: number | undefined;
}

/**
 * @public
 */
export interface DeliverQueueMessageOutput {
  /**
   * Present when the runtime wants the message redelivered instead of
   * acknowledged.
   * @public
   */
  retry?: RetryDirective | undefined;
}

/**
 * @public
 */
export interface DescribeRunInput {
  /**
   * The run entity as the caller holds it, which may be a lean
   * observability row rather than a full record.
   * @public
   */
  run: __DocumentType | undefined;
}

/**
 * @public
 */
export interface DescribeRunOutput {
  /**
   * World-specific display fields for one run, keyed by column name.
   *
   * A null value means "applicable but undeterminable", which is distinct from
   * the key being absent.
   * @public
   */
  fields?: Record<string, string | null> | undefined;
}

/**
 * @public
 */
export interface EnqueueOptions {
  /**
   * Target a specific deployment rather than the current one.
   * @public
   */
  deploymentId?: string | undefined;

  idempotencyKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * Delay delivery by this many seconds.
   * @public
   */
  delaySeconds?: number | undefined;

  /**
   * Spec version of the target run, which selects the transport format.
   * @public
   */
  specVersion?: number | undefined;

  /**
   * Routing hint naming the region the message should be sent to.
   * @public
   */
  region?: string | undefined;
}

/**
 * @public
 */
export interface EnqueueInput {
  /**
   * Logical queue name, e.g. a flow or step topic.
   * @public
   */
  queueName: string | undefined;

  /**
   * Opaque queue payload.
   *
   * The runtime's invoke and health-check payload schemas are deliberately not
   * modeled yet: they are producer-and-consumer-private, versioned by run spec
   * version, and encoded as CBOR or JSON depending on that version. Modeling
   * them belongs in a follow-up once the transport story is settled.
   * @public
   */
  message: Uint8Array | undefined;

  options?: EnqueueOptions | undefined;
}

/**
 * @public
 */
export interface EnqueueOutput {
  /**
   * Assigned message ID, when the queue reports one.
   * @public
   */
  messageId?: string | undefined;
}

/**
 * @public
 */
export interface GetDeploymentIdInput {}

/**
 * @public
 */
export interface GetDeploymentIdOutput {
  /**
   * Identifier of a deployment a run is pinned to.
   * @public
   */
  deploymentId: string | undefined;
}

/**
 * @public
 */
export interface GetEncryptionKeyForRunInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Opaque world-specific context, such as a deployment ID, used when
   * the run entity is not available locally.
   * @public
   */
  context?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface GetEncryptionKeyForRunOutput {
  /**
   * A ready-to-use AES-256 key.
   * @public
   */
  key?: Uint8Array | undefined;
}

/**
 * @public
 */
export interface GetEnvironmentInput {}

/**
 * @public
 */
export interface GetEnvironmentOutput {
  environment?: string | undefined;
}

/**
 * @public
 */
export interface GetEventInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Identifier of an event within a run's log.
   * @public
   */
  eventId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * @public
 */
export interface GetEventOutput {
  /**
   * One committed entry in a run's event log.
   * @public
   */
  event: Event | undefined;
}

/**
 * @public
 */
export interface GetHookInput {
  /**
   * Identifier of a hook.
   * @public
   */
  hookId: string | undefined;

  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * @public
 */
export interface GetHookOutput {
  /**
   * Materialized view of a hook.
   *
   * A hook kept alive by minimum retention stays readable after its run ends
   * and continues to reserve its token, but can no longer be resumed.
   * @public
   */
  hook: Hook | undefined;
}

/**
 * @public
 */
export interface GetHookByTokenInput {
  token: string | undefined;
  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * @public
 */
export interface GetHookByTokenOutput {
  /**
   * Materialized view of a hook.
   *
   * A hook kept alive by minimum retention stays readable after its run ends
   * and continues to reserve its token, but can no longer be resumed.
   * @public
   */
  hook: Hook | undefined;
}

/**
 * @public
 */
export interface GetRunInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * @public
 */
export interface GetRunOutput {
  /**
   * Materialized view of a run.
   *
   * `input`, `output`, and `error` are absent when the caller asked for
   * `ResolveData$NONE`, and `output`/`error`/`completedAt` are only populated
   * once the run reaches the matching terminal status.
   * @public
   */
  run: WorkflowRun | undefined;
}

/**
 * @public
 */
export interface GetRuntimeDeadlineInput {}

/**
 * @public
 */
export interface GetRuntimeDeadlineOutput {
  deadline?: Date | undefined;
}

/**
 * @public
 */
export interface GetStepInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Identifier of a step within a run.
   * @public
   */
  stepId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;
}

/**
 * @public
 */
export interface GetStepOutput {
  /**
   * Materialized view of a step.
   * @public
   */
  step: Step | undefined;
}

/**
 * @public
 */
export interface GetStreamInfoInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;
}

/**
 * @public
 */
export interface GetStreamInfoOutput {
  /**
   * Index of the last known chunk, or -1 when the stream is empty.
   * @public
   */
  tailIndex: number | undefined;

  /**
   * Whether the stream is closed.
   * @public
   */
  done: boolean | undefined;
}

/**
 * @public
 */
export interface GetWorldInfoInput {}

/**
 * @public
 */
export interface HookRetentionCapability {
  active: boolean | undefined;
}

/**
 * Feature capabilities an implementation declares.
 *
 * Every member defaults to unsupported when absent: a runtime fast path
 * gated on a capability must keep its conservative behavior unless the
 * capability is explicitly declared.
 * @public
 */
export interface WorldCapabilities {
  /**
   * Supports minimum token retention for hooks.
   * @public
   */
  hookRetention?: HookRetentionCapability | undefined;

  /**
   * Fences a stale replay-context write with `PreconditionFailedError`
   * rather than committing it. Accepting a snapshot and ignoring it is not
   * the same thing, and must leave this unset.
   * @public
   */
  preconditionGuard?: boolean | undefined;

  /**
   * The queue supports concurrency-limited consumption, including the
   * per-run topics consumed with a limit of one.
   * @public
   */
  maxConcurrency?: boolean | undefined;

  /**
   * `CreateEvent` deduplicates concurrent `hookReceived` writes carrying
   * the same `(runId, resumeId)`, collapsing them onto one committed
   * event.
   * @public
   */
  hookResumeDedup?: boolean | undefined;

  /**
   * Deployment IDs are atomic and immutable, so a run pinned to one may
   * only execute there. Implementations whose deployment ID is synthetic
   * or version-tagged must leave this unset.
   * @public
   */
  deploymentAffinity?: boolean | undefined;

  /**
   * Event IDs encode the event's dense, 1-based slot in its run's log.
   * Implies both density and bump-and-report on contention.
   * @public
   */
  slotEventIds?: boolean | undefined;
}

/**
 * @public
 */
export interface GetWorldInfoOutput {
  /**
   * Workflow protocol spec version this implementation writes.
   * Runtimes require an exact match before creating or replaying runs.
   * @public
   */
  specVersion: number | undefined;

  /**
   * Feature capabilities an implementation declares.
   *
   * Every member defaults to unsupported when absent: a runtime fast path
   * gated on a capability must keep its conservative behavior unless the
   * capability is explicitly declared.
   * @public
   */
  capabilities?: WorldCapabilities | undefined;

  /**
   * Optional capability services that are available.
   * @public
   */
  optionalCapabilities?: string[] | undefined;
}

/**
 * @public
 */
export interface ListEventsInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction for list operations, ordered by creation time.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * @public
 */
export interface ListEventsOutput {
  events: Event[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  hasMore: boolean | undefined;
}

/**
 * @public
 */
export interface ListEventsByCorrelationIdInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Correlation identifier tying an event to the entity it affects.
   * @public
   */
  correlationId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction for list operations, ordered by creation time.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * @public
 */
export interface ListEventsByCorrelationIdOutput {
  events: Event[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  hasMore: boolean | undefined;
}

/**
 * @public
 */
export interface ListHooksInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction for list operations, ordered by creation time.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * @public
 */
export interface ListHooksOutput {
  hooks: Hook[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  hasMore: boolean | undefined;
}

/**
 * @public
 */
export interface ListRunsInput {
  /**
   * Machine-readable workflow function name, e.g.
   * `workflow//./src/workflows/order//processOrder`.
   * @public
   */
  workflowName?: string | undefined;

  /**
   * Lifecycle status of a run.
   * @public
   */
  status?: RunStatus | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction for list operations, ordered by creation time.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * Retention window metadata returned by plan-aware list operations.
 * @public
 */
export interface PageInfo {
  currentLookbackDays: number | undefined;
  maxLookbackDays: number | undefined;
  currentWindowStart: Date | undefined;
  maxWindowStart: Date | undefined;
  upgradeAvailable: boolean | undefined;
}

/**
 * @public
 */
export interface ListRunsOutput {
  runs: WorkflowRun[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  hasMore: boolean | undefined;
  /**
   * Retention window metadata returned by plan-aware list operations.
   * @public
   */
  pageInfo?: PageInfo | undefined;
}

/**
 * @public
 */
export interface ListStepsInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Controls whether payload-bearing fields are resolved in a response.
   *
   * Smithy cannot vary an output shape by an input value, so payload members
   * stay optional and `NONE` simply leaves them absent.
   * @public
   */
  resolveData?: ResolveData | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction for list operations, ordered by creation time.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * @public
 */
export interface ListStepsOutput {
  steps: Step[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  hasMore: boolean | undefined;
}

/**
 * @public
 */
export interface ListStreamChunksInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;

  limit?: number | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * One chunk of a stream, with its 0-based position.
 * @public
 */
export interface StreamChunk {
  index: number | undefined;
  data: Uint8Array | undefined;
}

/**
 * @public
 */
export interface ListStreamChunksOutput {
  chunks: StreamChunk[] | undefined;
  /**
   * Opaque, implementation-defined pagination cursor.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Whether more already-written chunks remain.
   * @public
   */
  hasMore: boolean | undefined;

  /**
   * Whether the stream is closed.
   * @public
   */
  done: boolean | undefined;
}

/**
 * @public
 */
export interface ListStreamsInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;
}

/**
 * @public
 */
export interface ListStreamsOutput {
  names: string[] | undefined;
}

/**
 * Marks an operation that must never be exposed over a network transport.
 *
 * Operations carrying this trait exist so that in-process implementations
 * share one cross-language contract (TypeScript, Python) for behavior that
 * is resolved locally: ID minting, environment attribution, deadlines,
 * display enrichment, and encryption-key resolution. Any future transport
 * projection is expected to remove these operations from its closure and to
 * fail the build if one survives.
 * @public
 */
export interface LocalOnly {}

/**
 * Marks an operation as part of an optional World capability.
 *
 * Smithy services have no notion of an optional operation, so optional
 * behavior lives in its own service closure. This trait records which
 * capability an operation belongs to so wrappers and conformance tooling can
 * tie a generated service to the capability an implementation advertises in
 * `WorldInfo`.
 * @public
 */
export interface OptionalCapability {
  /**
   * Capability name as advertised by `WorldInfo$capabilities`.
   * @public
   */
  name: string | undefined;
}

/**
 * Cursor pagination request options.
 * @public
 */
export interface Pagination {
  /**
   * Maximum number of items to return.
   * @public
   */
  limit?: number | undefined;

  /**
   * Cursor returned by a previous page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Sort direction. Callers that depend on ordering should always set it.
   * @public
   */
  sortOrder?: SortOrder | undefined;
}

/**
 * @public
 */
export interface ReadStreamInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;

  startIndex?: number | undefined;
}

/**
 * @public
 */
export interface ReadStreamOutput {
  /**
   * An unbounded byte stream.
   * @public
   */
  body: StreamingBlobTypes | undefined;
}

/**
 * Structured error metadata carried by run and step failures.
 * @public
 */
export interface StructuredError {
  message: string | undefined;
  stack?: string | undefined;
  /**
   * Machine-readable error code, e.g. `USER_ERROR` or `RUNTIME_ERROR`.
   * @public
   */
  code?: string | undefined;
}

/**
 * @public
 */
export interface WriteStreamChunkInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;

  chunk: Uint8Array | undefined;
}

/**
 * @public
 */
export interface WriteStreamChunkOutput {}

/**
 * @public
 */
export interface WriteStreamChunksInput {
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  name: string | undefined;

  /**
   * Chunks to append, in order.
   * @public
   */
  chunks: Uint8Array[] | undefined;
}

/**
 * @public
 */
export interface WriteStreamChunksOutput {}
