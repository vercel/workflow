// smithy-typescript generated code
import {
  type ExceptionOptionType as __ExceptionOptionType,
  ServiceException as __BaseException,
} from "@smithy/core/client";

/**
 * The request was malformed or violated a validation rule.
 * @public
 */
export class BadRequestError extends __BaseException {
  readonly name = "BadRequestError" as const;
  readonly $fault = "client" as const;
  code?: string | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<BadRequestError, __BaseException>) {
    super({
      name: "BadRequestError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, BadRequestError.prototype);
    this.code = opts.code;
  }
}

/**
 * The implementation failed for a reason the caller cannot correct.
 * @public
 */
export class InternalError extends __BaseException {
  readonly name = "InternalError" as const;
  readonly $fault = "server" as const;
  $retryable = {};
  code?: string | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<InternalError, __BaseException>) {
    super({
      name: "InternalError",
      $fault: "server",
      ...opts,
    });
    Object.setPrototypeOf(this, InternalError.prototype);
    this.code = opts.code;
  }
}

/**
 * The caller is being throttled, or lost a contention retry budget.
 * @public
 */
export class ThrottledError extends __BaseException {
  readonly name = "ThrottledError" as const;
  readonly $fault = "client" as const;
  $retryable = {
    throttling: true,
  };
  retryAfter?: Date | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ThrottledError, __BaseException>) {
    super({
      name: "ThrottledError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, ThrottledError.prototype);
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * No run exists for the requested ID.
 * @public
 */
export class RunNotFoundError extends __BaseException {
  readonly name = "RunNotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<RunNotFoundError, __BaseException>) {
    super({
      name: "RunNotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, RunNotFoundError.prototype);
    this.runId = opts.runId;
  }
}

/**
 * The stream is gone: it passed its retention window.
 * @public
 */
export class StreamExpiredError extends __BaseException {
  readonly name = "StreamExpiredError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  streamName?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<StreamExpiredError, __BaseException>) {
    super({
      name: "StreamExpiredError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, StreamExpiredError.prototype);
    this.runId = opts.runId;
    this.streamName = opts.streamName;
  }
}

/**
 * No stream exists for the requested run and name.
 * @public
 */
export class StreamNotFoundError extends __BaseException {
  readonly name = "StreamNotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Name of a stream within a run.
   * @public
   */
  streamName?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<StreamNotFoundError, __BaseException>) {
    super({
      name: "StreamNotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, StreamNotFoundError.prototype);
    this.runId = opts.runId;
    this.streamName = opts.streamName;
  }
}

/**
 * The entity already exists, or its current state forbids this write.
 *
 * The runtime commonly reads this as "another writer won the race" rather
 * than as a hard failure.
 * @public
 */
export class ConflictError extends __BaseException {
  readonly name = "ConflictError" as const;
  readonly $fault = "client" as const;
  /**
   * Observed status of the entity, when the implementation reports one.
   * @public
   */
  status?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ConflictError, __BaseException>) {
    super({
      name: "ConflictError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, ConflictError.prototype);
    this.status = opts.status;
  }
}

/**
 * The run is gone: it passed its retention window or was otherwise expired.
 * @public
 */
export class ExpiredError extends __BaseException {
  readonly name = "ExpiredError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ExpiredError, __BaseException>) {
    super({
      name: "ExpiredError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, ExpiredError.prototype);
    this.runId = opts.runId;
  }
}

/**
 * A replay-context write was fenced because its snapshot is behind the run's
 * recorded log.
 *
 * Only implementations that advertise the `preconditionGuard` capability
 * raise this. It is unrelated to slot allocation: a slot-numbering World
 * bumps to the next free slot and reports the events it skipped instead of
 * rejecting the write.
 * @public
 */
export class PreconditionFailedError extends __BaseException {
  readonly name = "PreconditionFailedError" as const;
  readonly $fault = "client" as const;
  /**
   * Number of events the World held when it rejected the write.
   * @public
   */
  eventCount?: number | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<PreconditionFailedError, __BaseException>) {
    super({
      name: "PreconditionFailedError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, PreconditionFailedError.prototype);
    this.eventCount = opts.eventCount;
  }
}

/**
 * The operation was attempted before its earliest valid time.
 * @public
 */
export class TooEarlyError extends __BaseException {
  readonly name = "TooEarlyError" as const;
  readonly $fault = "client" as const;
  /**
   * Earliest time at which the operation may be retried.
   * @public
   */
  retryAfter?: Date | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<TooEarlyError, __BaseException>) {
    super({
      name: "TooEarlyError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, TooEarlyError.prototype);
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * No event exists for the requested ID.
 * @public
 */
export class EventNotFoundError extends __BaseException {
  readonly name = "EventNotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Identifier of an event within a run's log.
   * @public
   */
  eventId?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<EventNotFoundError, __BaseException>) {
    super({
      name: "EventNotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, EventNotFoundError.prototype);
    this.runId = opts.runId;
    this.eventId = opts.eventId;
  }
}

/**
 * No hook exists for the requested ID or token.
 * @public
 */
export class HookNotFoundError extends __BaseException {
  readonly name = "HookNotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a hook.
   * @public
   */
  hookId?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<HookNotFoundError, __BaseException>) {
    super({
      name: "HookNotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, HookNotFoundError.prototype);
    this.hookId = opts.hookId;
  }
}

/**
 * No step exists for the requested ID.
 * @public
 */
export class StepNotFoundError extends __BaseException {
  readonly name = "StepNotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * Identifier of a workflow run.
   * @public
   */
  runId?: string | undefined;

  /**
   * Identifier of a step within a run.
   * @public
   */
  stepId?: string | undefined;

  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<StepNotFoundError, __BaseException>) {
    super({
      name: "StepNotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, StepNotFoundError.prototype);
    this.runId = opts.runId;
    this.stepId = opts.stepId;
  }
}
