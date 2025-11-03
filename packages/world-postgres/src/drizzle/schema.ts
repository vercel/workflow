import {
  type Event,
  type Hook,
  type Step,
  StepStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

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

export const runs = pgTable(
  'workflow_runs',
  {
    runId: varchar('id').primaryKey(),
    output: jsonb('output').$type<SerializedContent>(),
    deploymentId: varchar('deployment_id').notNull(),
    status: workflowRunStatus('status').notNull(),
    workflowName: varchar('name').notNull(),
    executionContext: jsonb('execution_context').$type<Record<string, any>>(),
    input: jsonb('input').$type<SerializedContent>().notNull(),
    error: text('error'),
    errorCode: varchar('error_code'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at'),
    startedAt: timestamp('started_at'),
  } satisfies DrizzlishOfType<WorkflowRun>,
  (tb) => ({
    workflowNameIdx: index().on(tb.workflowName),
    statusIdx: index().on(tb.status),
  })
);

export const events = pgTable(
  'workflow_events',
  {
    eventId: varchar('id').primaryKey(),
    eventType: varchar('type').$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    runId: varchar('run_id').notNull(),
    eventData: jsonb('payload'),
  } satisfies DrizzlishOfType<Event & { eventData?: undefined }>,
  (tb) => ({
    runFk: index().on(tb.runId),
    correlationIdFk: index().on(tb.correlationId),
  })
);

export const steps = pgTable(
  'workflow_steps',
  {
    runId: varchar('run_id').notNull(),
    stepId: varchar('step_id').primaryKey(),
    stepName: varchar('step_name').notNull(),
    status: stepStatus('status').notNull(),
    input: jsonb('input').$type<SerializedContent>().notNull(),
    output: jsonb('output').$type<SerializedContent>(),
    error: text('error'),
    errorCode: varchar('error_code'),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after'),
  } satisfies DrizzlishOfType<Step>,
  (tb) => ({
    runFk: index().on(tb.runId),
    statusIdx: index().on(tb.status),
  })
);

export const hooks = pgTable(
  'workflow_hooks',
  {
    runId: varchar('run_id').notNull(),
    hookId: varchar('hook_id').primaryKey(),
    token: varchar('token').notNull(),
    ownerId: varchar('owner_id').notNull(),
    projectId: varchar('project_id').notNull(),
    environment: varchar('environment').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<SerializedContent>(),
  } satisfies DrizzlishOfType<Hook>,
  (tb) => ({
    runFk: index().on(tb.runId),
    tokenIdx: index().on(tb.token),
  })
);

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const streams = pgTable(
  'workflow_stream_chunks',
  {
    chunkId: varchar('id').$type<`chnk_${string}`>().notNull(),
    streamId: varchar('stream_id').notNull(),
    chunkData: bytea('data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => ({
    primaryKey: primaryKey({ columns: [tb.streamId, tb.chunkId] }),
  })
);
