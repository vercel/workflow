import {
  type Event,
  type Hook,
  type SerializedData,
  type Step,
  StepStatusSchema,
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
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { Cbor, type Cborized } from './cbor.js';

function mustBeMoreThanOne<T>(t: T[]) {
  return t as [T, ...T[]];
}

export const workflowRunStatus = pgEnum(
  'status',
  mustBeMoreThanOne(WorkflowRunStatusSchema.options)
);

export const stepStatus = pgEnum(
  'step_status',
  mustBeMoreThanOne(StepStatusSchema.options)
);

export const waitStatus = pgEnum(
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

export const schema = pgSchema('workflow');

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
    /** @deprecated - use error instead (legacy JSON-stringified StructuredError) */
    errorJson: text('error'),
    /**
     * The thrown value from a run_failed event, serialized via the workflow
     * serialization pipeline (dehydrateRunError). Stored as a Uint8Array and
     * wrapped in CBOR for transport.
     */
    error: Cbor<SerializedData>()('error_cbor'),
    /**
     * The high-level error category (USER_ERROR, RUNTIME_ERROR, etc.) from
     * a run_failed event. Plaintext metadata for routing — does not require
     * decryption or hydration.
     */
    errorCode: varchar('error_code'),
    /**
     * Plaintext string-string metadata attached to the run via
     * `setAttributes()`. EXPERIMENTAL MVP: stored as JSONB to allow
     * SQL-side merge (`jsonb_set` / `jsonb_strip_nulls`) without a
     * read-modify-write cycle. Defaults to `{}` so existing rows
     * (pre-migration) read as the empty map.
     */
    attributes: jsonb('attributes')
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at'),
    startedAt: timestamp('started_at'),
    expiredAt: timestamp('expired_at'),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    runId: varchar('run_id').notNull(),
    /** @deprecated */
    eventDataJson: jsonb('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<Event & { eventData?: undefined }, 'eventData'>
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
    /** @deprecated - use error instead (legacy JSON-stringified StructuredError) */
    errorJson: text('error'),
    /**
     * The thrown value from a step_failed / step_retrying event, serialized
     * via the workflow serialization pipeline (dehydrateStepError). Stored
     * as a Uint8Array and wrapped in CBOR for transport.
     */
    error: Cbor<SerializedData>()('error_cbor'),
    attempt: integer('attempt').notNull(),
    /** Maps to startedAt in Step interface */
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after'),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** @deprecated */
    metadataJson: jsonb('metadata').$type<SerializedContent>(),
    metadata: Cbor<SerializedContent>()('metadata_cbor'),
    specVersion: integer('spec_version'),
    isWebhook: boolean('is_webhook').default(true),
    isSystem: boolean('is_system').default(false),
  } satisfies DrizzlishOfType<Cborized<Hook, 'metadata'>>,
  (tb) => [index().on(tb.runId), index().on(tb.token)]
);

export const waits = schema.table(
  'workflow_waits',
  {
    waitId: varchar('wait_id').primaryKey(),
    runId: varchar('run_id').notNull(),
    status: waitStatus('status').notNull(),
    resumeAt: timestamp('resume_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.streamId, tb.chunkId] }),
    index().on(tb.runId),
  ]
);
