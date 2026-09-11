import { z } from 'zod';
import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
  RunCreatedEventRequest,
} from './events.js';
import { CreateEventSchema, EventSchema } from './events.js';

/** Experimental, root-only protocol. No durable pending inbox or body leases. */
export const EXECUTION_PROFILE = 'single-owner-v1' as const;

export const ExecutionFaultSchema = z.object({
  code: z.literal('EXECUTION_INVARIANT_VIOLATION'),
  message: z.string(),
  activationId: z.string().optional(),
});

export const ExecutionSnapshotSchema = z.object({
  profile: z.literal(EXECUTION_PROFILE),
  runId: z.string(),
  deploymentId: z.string(),
  tenant: z.object({
    ownerId: z.string(),
    projectId: z.string(),
    environment: z.string(),
  }),
  head: z.number().int().nonnegative(),
  events: z.array(EventSchema),
  fault: ExecutionFaultSchema.optional(),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

export const ExecutionInputSchema = z.object({
  operationId: z.string().min(1).max(128),
  event: CreateEventSchema.transform((event, ctx): CreateEventRequest => {
    if (event.eventType === 'run_created') {
      ctx.addIssue({
        code: 'custom',
        message: 'Creation is not an external submission',
      });
      return z.NEVER;
    }
    if (
      !['hook_received', 'hook_disposed', 'run_cancelled', 'attr_set'].includes(
        event.eventType
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Submission must be an external input, not an owner event',
      });
      return z.NEVER;
    }
    return event;
  }),
});
export type ExecutionInput = z.infer<typeof ExecutionInputSchema>;

export interface ExecutionExchange {
  runId: string;
  deploymentId: string;
  activationId: string;
  operationId: string;
  expectedHead: number;
  events: CreateEventRequest[];
}

export const ExecutionReceiptSchema = z.object({
  operationId: z.string(),
  head: z.number().int().positive(),
  events: z.array(EventSchema).min(1),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

/** A fatal assertion, never a stale-snapshot signal to catch and repair. */
export class ExecutionInvariantError extends Error {
  readonly code = 'EXECUTION_INVARIANT_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionInvariantError';
  }
  static is(error: unknown): error is ExecutionInvariantError {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EXECUTION_INVARIANT_VIOLATION'
    );
  }
}

/**
 * Platform-neutral execution boundary. acquire loads, it does not elect
 * an owner. claim is an ordered step_started exchange; renew is intentionally
 * absent because this profile implements no independent body lease.
 */
export interface ExecutionStorage {
  readonly profile: typeof EXECUTION_PROFILE;
  create(
    runId: string,
    event: RunCreatedEventRequest
  ): Promise<ExecutionSnapshot>;
  acquire(runId: string): Promise<ExecutionSnapshot>;
  exchange(request: ExecutionExchange): Promise<ExecutionReceipt>;
  /**
   * Adapter-owned ingress and session lifetime. The adapter validates delivery,
   * selects the run, and maintains a single session under its ownership model.
   * Core supplies only the platform-neutral workflow session implementation.
   */
  createHandler(
    factory: (runId: string) => ExecutionSession,
    options?: {
      namespace?: string;
    }
  ): (request: Request) => Promise<Response>;
  /** Durable retry lookup; undefined means this operation has not committed. */
  receipt(
    runId: string,
    operationId: string
  ): Promise<ExecutionReceipt | undefined>;
  submit<T extends CreateEventRequest>(
    runId: string,
    event: T,
    params?: CreateEventParams
  ): Promise<EventResult<T['eventType']>>;
  quarantine(
    runId: string,
    fault: z.infer<typeof ExecutionFaultSchema>
  ): Promise<void>;
}

export interface ExecutionSession {
  receive(input?: ExecutionInput): Promise<void>;
}

export function assertExecutionSnapshot(snapshot: ExecutionSnapshot): void {
  if (snapshot.fault) throw new ExecutionInvariantError(snapshot.fault.message);
  if (snapshot.head !== snapshot.events.length || snapshot.head < 1) {
    throw new ExecutionInvariantError(
      'Execution snapshot is not a complete committed prefix'
    );
  }
  for (const [index, event] of snapshot.events.entries()) {
    const expected = `evnt_${String(index + 1).padStart(26, '0')}`;
    if (event.runId !== snapshot.runId || event.eventId !== expected) {
      throw new ExecutionInvariantError(
        `Execution journal is not contiguous at ${expected}`
      );
    }
  }
  const first = snapshot.events[0];
  if (
    first.eventType !== 'run_created' ||
    first.eventData.deploymentId !== snapshot.deploymentId
  ) {
    throw new ExecutionInvariantError(
      'Execution journal does not match its immutable deployment'
    );
  }
}
