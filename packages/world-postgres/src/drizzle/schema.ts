import {
  type Event,
  type Hook,
  type Step,
  StepStatusSchema,
  type StructuredError,
  type Wait,
  WaitStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  /** @deprecated: use Cbor instead */
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { Cbor, type Cborized } from './cbor.js';

export const schema = pgSchema('workflow');

/** A UTC offset (`+00`, `-07`, `+05:30`) or `Z` at the end of a timestamp. */
const UTC_OFFSET = /(?:[+-]\d\d(?::?\d\d){0,2}|Z)$/;

/**
 * Every timestamp column is `timestamp with time zone`, so it stores an
 * instant. With `timestamp without time zone`, `DEFAULT now()` stored the
 * session's local wall time while drizzle read every value back as UTC, which
 * put `createdAt` hours off on servers not running in UTC (migration 0027).
 *
 * Postgres prints `timestamptz` values with their offset. A value without one
 * comes from a column migration 0027 has not converted yet, which held UTC
 * wall times for everything written from JavaScript, so read it as UTC, as
 * earlier versions did. Drizzle's own `withTimezone` reader would parse it in
 * the Node process's local time zone instead.
 */
const timestamptz = customType<{ data: Date; driverData: string | Date }>({
  dataType: () => 'timestamp with time zone',
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => {
    if (value instanceof Date) return value;
    return new Date(UTC_OFFSET.test(value) ? value : `${value}Z`);
  },
});

function mustBeMoreThanOne<T>(t: T[]) {
  return t as [T, ...T[]];
}

export const workflowRunStatus = schema.enum(
  'status',
  mustBeMoreThanOne(WorkflowRunStatusSchema.options)
);

export const stepStatus = schema.enum(
  'step_status',
  mustBeMoreThanOne(StepStatusSchema.options)
);

export const waitStatus = schema.enum(
  'wait_status',
  mustBeMoreThanOne(WaitStatusSchema.options)
);

/**
 * A mapped type that converts all properties of T to Drizzle ORM column definitions,
 * marking them as not nullable if they are not optional in T.
 */
type DrizzlishOfType<T extends object> = {
  [key in keyof T]-?: undefined extends T[key]
    ? { _: { notNull: boolean } }
    : { _: { notNull: true } };
};

/**
 * Sadly we do `any[]` right now
 */
export type SerializedContent = any[];

export const runs = schema.table(
  'workflow_runs',
  {
    runId: varchar('id').primaryKey(),
    /** @deprecated */
    outputJson: jsonb('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    deploymentId: varchar('deployment_id').notNull(),
    status: workflowRunStatus('status').notNull(),
    workflowName: varchar('name').notNull(),
    specVersion: integer('spec_version'),
    /** @deprecated */
    executionContextJson:
      jsonb('execution_context').$type<Record<string, any>>(),
    executionContext: Cbor<Record<string, any>>()('execution_context_cbor'),
    /** @deprecated */
    inputJson: jsonb('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    /** @deprecated - use error instead */
    errorJson: text('error'),
    error: Cbor<StructuredError>()('error_cbor'),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    updatedAt: timestamptz('updated_at')
      .default(sql`now()`)
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamptz('completed_at'),
    startedAt: timestamptz('started_at'),
    expiredAt: timestamptz('expired_at'),
  } satisfies DrizzlishOfType<
    Cborized<
      Omit<WorkflowRun, 'input'> & { input?: unknown },
      'input' | 'output' | 'executionContext' | 'error'
    >
  >,
  (tb) => [index().on(tb.workflowName), index().on(tb.status)]
);

export const events = schema.table(
  'workflow_events',
  {
    eventId: varchar('id').primaryKey(),
    eventType: varchar('type').$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id'),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    runId: varchar('run_id').notNull(),
    /** @deprecated */
    eventDataJson: jsonb('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<Omit<Event, 'occurredAt'> & { eventData?: undefined }, 'eventData'>
  >,
  (tb) => [
    index().on(tb.runId),
    index().on(tb.correlationId),
    // Entity-creating events must be unique per (run, correlation) — without
    // this, two concurrent invocations producing identical correlationIds
    // (e.g. the snapshot runtime's deterministic ULIDs across replays) can
    // both insert events, causing duplicate steps/hooks/waits in the log.
    // The unique violation is caught in events.create and translated to
    // EntityConflictError, matching the runtime's expected dedup contract.
    uniqueIndex('workflow_events_entity_creation_unique')
      .on(tb.runId, tb.correlationId, tb.eventType)
      .where(
        sql`${tb.eventType} IN ('step_created', 'hook_created', 'wait_created')`
      ),
  ]
);

export const steps = schema.table(
  'workflow_steps',
  {
    runId: varchar('run_id').notNull(),
    stepId: varchar('step_id').primaryKey(),
    stepName: varchar('step_name').notNull(),
    status: stepStatus('status').notNull(),
    /** @deprecated */
    inputJson: jsonb('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    /** @deprecated we stream binary data */
    outputJson: jsonb('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    /** @deprecated - use error instead */
    errorJson: text('error'),
    error: Cbor<StructuredError>()('error_cbor'),
    attempt: integer('attempt').notNull(),
    /** Maps to startedAt in Step interface */
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    updatedAt: timestamptz('updated_at')
      .default(sql`now()`)
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamptz('retry_after'),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<
      Omit<Step, 'input'> & {
        input?: unknown;
      },
      'output' | 'input' | 'error'
    >
  >,
  (tb) => [index().on(tb.runId), index().on(tb.status)]
);

export const hooks = schema.table(
  'workflow_hooks',
  {
    runId: varchar('run_id').notNull(),
    hookId: varchar('hook_id').primaryKey(),
    token: varchar('token').notNull(),
    ownerId: varchar('owner_id').notNull(),
    projectId: varchar('project_id').notNull(),
    environment: varchar('environment').notNull(),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    /** @deprecated */
    metadataJson: jsonb('metadata').$type<SerializedContent>(),
    metadata: Cbor<SerializedContent>()('metadata_cbor'),
    specVersion: integer('spec_version'),
    isWebhook: boolean('is_webhook').default(true),
  } satisfies DrizzlishOfType<Cborized<Hook, 'metadata'>>,
  (tb) => [index().on(tb.runId), index().on(tb.token)]
);

export const waits = schema.table(
  'workflow_waits',
  {
    waitId: varchar('wait_id').primaryKey(),
    runId: varchar('run_id').notNull(),
    status: waitStatus('status').notNull(),
    resumeAt: timestamptz('resume_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    updatedAt: timestamptz('updated_at')
      .default(sql`now()`)
      .$onUpdateFn(() => new Date())
      .notNull(),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<Wait>,
  (tb) => [index().on(tb.runId)]
);

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const streams = schema.table(
  'workflow_stream_chunks',
  {
    chunkId: varchar('id').$type<`chnk_${string}`>().notNull(),
    streamId: varchar('stream_id').notNull(),
    runId: varchar('run_id'),
    chunkData: bytea('data').notNull(),
    createdAt: timestamptz('created_at').default(sql`now()`).notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.streamId, tb.chunkId] }),
    index().on(tb.runId),
  ]
);
