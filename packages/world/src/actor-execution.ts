import { z } from 'zod';
import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
  RunCreatedEventRequest,
} from './events.js';
import { CreateEventSchema, EventSchema } from './events.js';

/** Experimental, root-only protocol. No durable pending inbox or body leases. */
export const ACTOR_EXECUTION_PROFILE = 'actor-owner-v1' as const;

export const ActorFaultSchema = z.object({
  code: z.literal('ACTOR_INVARIANT_VIOLATION'),
  message: z.string(),
  activationId: z.string().optional(),
});

export const ActorSnapshotSchema = z.object({
  profile: z.literal(ACTOR_EXECUTION_PROFILE),
  runId: z.string(),
  deploymentId: z.string(),
  tenant: z.object({
    ownerId: z.string(),
    projectId: z.string(),
    environment: z.string(),
  }),
  head: z.number().int().nonnegative(),
  events: z.array(EventSchema),
  fault: ActorFaultSchema.optional(),
});
export type ActorSnapshot = z.infer<typeof ActorSnapshotSchema>;

export const ActorCommandSchema = z.object({
  operationId: z.string().min(1).max(128),
  event: CreateEventSchema.transform((event, ctx): CreateEventRequest => {
    if (event.eventType === 'run_created') {
      ctx.addIssue({
        code: 'custom',
        message: 'Creation is not an actor submission',
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
        message:
          'Actor submission must be an external input, not an owner event',
      });
      return z.NEVER;
    }
    return event;
  }),
});
export type ActorCommand = z.infer<typeof ActorCommandSchema>;

export interface ActorExchange {
  runId: string;
  deploymentId: string;
  activationId: string;
  operationId: string;
  expectedHead: number;
  events: CreateEventRequest[];
}

export const ActorReceiptSchema = z.object({
  operationId: z.string(),
  head: z.number().int().positive(),
  events: z.array(EventSchema).min(1),
});
export type ActorReceipt = z.infer<typeof ActorReceiptSchema>;

/** A fatal assertion, never a stale-snapshot signal to catch and repair. */
export class ActorInvariantError extends Error {
  readonly code = 'ACTOR_INVARIANT_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'ActorInvariantError';
  }
  static is(error: unknown): error is ActorInvariantError {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ACTOR_INVARIANT_VIOLATION'
    );
  }
}

/**
 * Client/storage boundary for the affinity POC. acquire loads, it does not elect
 * an owner. claim is an ordered step_started exchange; renew is intentionally
 * absent because this profile implements no independent body lease.
 */
export interface ActorExecution {
  readonly profile: typeof ACTOR_EXECUTION_PROFILE;
  create(runId: string, event: RunCreatedEventRequest): Promise<ActorSnapshot>;
  acquire(runId: string): Promise<ActorSnapshot>;
  exchange(request: ActorExchange): Promise<ActorReceipt>;
  /** Durable retry lookup; undefined means this operation has not committed. */
  receipt(
    runId: string,
    operationId: string
  ): Promise<ActorReceipt | undefined>;
  submit<T extends CreateEventRequest>(
    runId: string,
    event: T,
    params?: CreateEventParams
  ): Promise<EventResult<T['eventType']>>;
  quarantine(
    runId: string,
    fault: z.infer<typeof ActorFaultSchema>
  ): Promise<void>;
}

export function assertActorSnapshot(snapshot: ActorSnapshot): void {
  if (snapshot.fault) throw new ActorInvariantError(snapshot.fault.message);
  if (snapshot.head !== snapshot.events.length || snapshot.head < 1) {
    throw new ActorInvariantError(
      'Actor snapshot is not a complete committed prefix'
    );
  }
  for (const [index, event] of snapshot.events.entries()) {
    const expected = `evnt_${String(index + 1).padStart(26, '0')}`;
    if (event.runId !== snapshot.runId || event.eventId !== expected) {
      throw new ActorInvariantError(
        `Actor journal is not contiguous at ${expected}`
      );
    }
  }
  const first = snapshot.events[0];
  if (
    first.eventType !== 'run_created' ||
    first.eventData.deploymentId !== snapshot.deploymentId
  ) {
    throw new ActorInvariantError(
      'Actor journal does not match its immutable deployment'
    );
  }
}
