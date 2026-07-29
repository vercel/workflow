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
  bigint,
  boolean,
  customType,
  index,
  integer,
  /** @deprecated: use Cbor instead */
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { Cbor, type Cborized } from './cbor.js';

export const schema = pgSchema('workflow');

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
    /**
     * The run's X25519 public key (base64), stamped at creation by SDKs that
     * support sealed (`encp`) envelopes. Lets cross-run writers seal payloads
     * to this run without holding its symmetric key. Not secret — the private
     * scalar is re-derived on demand and never stored. Null on runs created by
     * older SDKs, which fall back to the symmetric path.
     */
    encryptionPublicKey: varchar('encryption_public_key'),
    /**
     * Commit-ordered append state. `nextEventSeq` is the number of events
     * committed to this run's log — the next event takes `nextEventSeq + 1`.
     * `lastEventId` is the id of the run's current log tail; new event ids are
     * minted at the append point to sort strictly after it, so event-id order
     * == seq order == commit order. Both are only read/written inside the
     * per-run append transaction (see `allocateEventPositions` in storage.ts),
     * which serializes appends via a run-scoped advisory lock.
     */
    nextEventSeq: bigint('next_event_seq', { mode: 'number' })
      .default(0)
      .notNull(),
    lastEventId: varchar('last_event_id'),
    /**
     * Currency-fence credit: the precondition snapshot (`stateCursor` +
     * `stateEventCount`) of the last fenced writer that appended from an
     * up-to-date view. A suspension flushes several creates that share one
     * snapshot; the first establishes the credit and the rest match it, so
     * siblings never fence each other while a *different* stale snapshot is
     * still rejected with 412.
     */
    writerSnapshot: varchar('writer_snapshot'),
    writerBaseCount: bigint('writer_base_count', { mode: 'number' }),
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
    > & {
      nextEventSeq: number;
      lastEventId?: string;
      writerSnapshot?: string;
      writerBaseCount?: number;
    }
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
    /**
     * Dense per-run log position (1, 2, 3, …) allocated at the append point
     * inside the per-run append transaction. Null on events written before
     * the World gained commit-ordered appends (and on legacy-spec runs).
     * See the `seq` field contract on `EventSchema` in `@workflow/world`.
     */
    seq: bigint('seq', { mode: 'number' }),
  } satisfies DrizzlishOfType<
    Cborized<Omit<Event, 'occurredAt'> & { eventData?: undefined }, 'eventData'>
  >,
  (tb) => [
    index().on(tb.runId),
    index().on(tb.correlationId),
    // Dense positions must be unique per run. Multiple NULLs are allowed
    // (pre-migration events), and the append serializer makes real
    // collisions impossible — this index is the invariant's tripwire.
    uniqueIndex('workflow_events_run_seq_unique').on(tb.runId, tb.seq),
    // Runtime-correlated one-shot events must be unique per (run, correlation)
    // — without
    // this, two concurrent invocations producing identical correlationIds
    // (e.g. the snapshot runtime's deterministic ULIDs across replays) can
    // both insert events, causing duplicate operations in the log.
    // The unique violation is caught in events.create and translated to
    // EntityConflictError, matching the runtime's expected dedup contract.
    uniqueIndex('workflow_events_entity_creation_unique')
      .on(tb.runId, tb.correlationId, tb.eventType)
      .where(
        sql`${tb.eventType} IN ('step_created', 'hook_created', 'wait_created', 'attr_set')`
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
    // Server-synthesized resume slice. Not carried by the hook_created event,
    // so this backend leaves it null; reads fall back to runs.get.
    resumeContext: Cbor<NonNullable<Hook['resumeContext']>>()('resume_context'),
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
