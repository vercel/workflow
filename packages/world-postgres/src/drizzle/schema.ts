import {
  type Event,
  type Hook,
  type Step,
  StepStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb as jsonb_,
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/** @deprecated - use Cbor instead */
const jsonb = jsonb_;

const Cbor = <T>() =>
  customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'bytea',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });

type Cborized<K extends string> = {
  [key in `${K}Json`]: unknown;
};

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
    /** @deprecated */
    executionContextJson:
      jsonb('execution_context').$type<Record<string, any>>(),
    executionContext: Cbor<Record<string, any>>()('execution_context_cbor'),
    /** @deprecated */
    inputJson: jsonb('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at'),
    startedAt: timestamp('started_at'),
  } satisfies DrizzlishOfType<
    Omit<WorkflowRun, 'input'> & { input?: unknown } & Cborized<
        'output' | 'input' | 'executionContext'
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
  } satisfies DrizzlishOfType<
    Event & Cborized<'eventData'> & { eventData?: undefined }
  >,
  (tb) => [index().on(tb.runId), index().on(tb.correlationId)]
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
    error: text('error'),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after'),
  } satisfies DrizzlishOfType<Omit<Step, 'input'> & { input?: unknown }> &
    Cborized<'output' | 'input'>,
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
  } satisfies DrizzlishOfType<Hook> & Cborized<'metadata'>,
  (tb) => [index().on(tb.runId), index().on(tb.token)]
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
    chunkData: bytea('data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => [primaryKey({ columns: [tb.streamId, tb.chunkId] })]
);
