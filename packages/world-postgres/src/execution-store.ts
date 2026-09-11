import { createHash } from 'node:crypto';
import { RunExpiredError } from '@workflow/errors';
import {
  CreateEventSchema,
  EXECUTION_PROFILE,
  type ExecutionExchange,
  type ExecutionInput,
  ExecutionInputSchema,
  ExecutionInvariantError,
  type ExecutionReceipt,
  type ExecutionSnapshot,
  ExecutionSnapshotSchema,
  projectExecutionSnapshot,
  type RunCreatedEventRequest,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { Pool, PoolClient } from 'pg';

export const EXECUTION_DDL = `
CREATE SCHEMA IF NOT EXISTS workflow_execution;
CREATE TABLE IF NOT EXISTS workflow_execution.runs (
  namespace text NOT NULL, run_id text NOT NULL, head bigint NOT NULL,
  snapshot bytea NOT NULL, fault jsonb, owner_id text,
  PRIMARY KEY (namespace, run_id)
);
CREATE TABLE IF NOT EXISTS workflow_execution.receipts (
  namespace text NOT NULL, run_id text NOT NULL, operation_id text NOT NULL,
  fingerprint text NOT NULL, receipt bytea NOT NULL,
  PRIMARY KEY (namespace, run_id, operation_id),
  FOREIGN KEY (namespace, run_id) REFERENCES workflow_execution.runs(namespace, run_id)
);
CREATE TABLE IF NOT EXISTS workflow_execution.inputs (
  namespace text NOT NULL, run_id text NOT NULL, operation_id text NOT NULL,
  fingerprint text NOT NULL, input bytea NOT NULL,
  PRIMARY KEY (namespace, run_id, operation_id),
  FOREIGN KEY (namespace, run_id) REFERENCES workflow_execution.runs(namespace, run_id)
);
CREATE TABLE IF NOT EXISTS workflow_execution.hooks (
  namespace text NOT NULL, token text NOT NULL, run_id text NOT NULL, hook_id text NOT NULL,
  PRIMARY KEY (namespace, token),
  FOREIGN KEY (namespace, run_id) REFERENCES workflow_execution.runs(namespace, run_id)
);`;

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input instanceof Date || input instanceof Uint8Array) return input;
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)])
      );
    return input;
  };
  return createHash('sha256')
    .update(encode(canonical(value)))
    .digest('hex');
}

/** Bounded reference backend. Snapshot, receipt and hook effects commit together. */
export class ExecutionStore {
  constructor(
    readonly pool: Pool,
    readonly namespace: string
  ) {}

  async setup() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize first-use schema initialization across World instances.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('workflow_execution.setup',0))"
      );
      await client.query(EXECUTION_DDL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Called only while holding this run's session-level advisory lock. */
  async claim(client: PoolClient, runId: string, ownerId: string) {
    const result = await client.query(
      `UPDATE workflow_execution.runs
      SET owner_id=CASE WHEN owner_id IS NULL AND fault IS NULL THEN $3 ELSE owner_id END,
          fault=CASE WHEN owner_id IS NOT NULL THEN COALESCE(fault,$4::jsonb) ELSE fault END
      WHERE namespace=$1 AND run_id=$2 RETURNING fault`,
      [
        this.namespace,
        runId,
        ownerId,
        JSON.stringify({
          code: 'EXECUTION_INVARIANT_VIOLATION',
          message:
            'Previous execution owner disappeared without releasing its grant',
        }),
      ]
    );
    if (!result.rowCount) throw new Error('Execution not found');
    if (result.rows[0].fault)
      throw new ExecutionInvariantError(result.rows[0].fault.message);
  }

  async release(client: PoolClient, runId: string, ownerId: string) {
    const result = await client.query(
      'UPDATE workflow_execution.runs SET owner_id=NULL WHERE namespace=$1 AND run_id=$2 AND owner_id=$3',
      [this.namespace, runId, ownerId]
    );
    if (!result.rowCount)
      throw new ExecutionInvariantError(
        'Execution ownership changed during release'
      );
  }

  async stage(runId: string, input: ExecutionInput) {
    input = ExecutionInputSchema.parse(input);
    if (encode(input).byteLength > 128 * 1024)
      throw new Error('Execution input limit exceeded');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const loaded = await client.query(
        'SELECT snapshot,fault FROM workflow_execution.runs WHERE namespace=$1 AND run_id=$2 FOR UPDATE',
        [this.namespace, runId]
      );
      if (!loaded.rows[0]) throw new Error('Execution not found');
      if (loaded.rows[0].fault)
        throw new ExecutionInvariantError(loaded.rows[0].fault.message);
      const prior = await client.query(
        'SELECT fingerprint FROM workflow_execution.inputs WHERE namespace=$1 AND run_id=$2 AND operation_id=$3',
        [this.namespace, runId, input.operationId]
      );
      const hash = fingerprint(input);
      if (prior.rows[0]) {
        if (prior.rows[0].fingerprint !== hash) {
          const fault = {
            code: 'EXECUTION_INVARIANT_VIOLATION',
            message: 'Submission ID reused with different input',
          };
          await client.query(
            'UPDATE workflow_execution.runs SET fault=$3 WHERE namespace=$1 AND run_id=$2',
            [this.namespace, runId, fault]
          );
          await client.query('COMMIT');
          throw new ExecutionInvariantError(fault.message);
        }
      } else {
        const snapshot = ExecutionSnapshotSchema.parse(
          decode(loaded.rows[0].snapshot)
        );
        const run = projectExecutionSnapshot(snapshot).run;
        if (['completed', 'failed', 'cancelled'].includes(run.status))
          throw new RunExpiredError('Execution is terminal');
        const count = await client.query(
          `SELECT count(*) FROM workflow_execution.inputs i
          WHERE i.namespace=$1 AND i.run_id=$2 AND NOT EXISTS (SELECT 1 FROM workflow_execution.receipts r
          WHERE r.namespace=i.namespace AND r.run_id=i.run_id AND r.operation_id=i.operation_id)`,
          [this.namespace, runId]
        );
        if (Number(count.rows[0].count) >= 128)
          throw new Error('Execution inbox capacity exceeded');
        await client.query(
          'INSERT INTO workflow_execution.inputs(namespace,run_id,operation_id,fingerprint,input) VALUES($1,$2,$3,$4,$5)',
          [this.namespace, runId, input.operationId, hash, encode(input)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async pending(runId: string): Promise<ExecutionInput[]> {
    const snapshot = await this.snapshot(runId);
    if (
      !snapshot ||
      ['completed', 'failed', 'cancelled'].includes(
        projectExecutionSnapshot(snapshot).run.status
      )
    )
      return [];
    const result = await this.pool.query(
      `SELECT i.input FROM workflow_execution.inputs i
      WHERE i.namespace=$1 AND i.run_id=$2 AND NOT EXISTS (SELECT 1 FROM workflow_execution.receipts r
        WHERE r.namespace=i.namespace AND r.run_id=i.run_id AND r.operation_id=i.operation_id)
      ORDER BY i.operation_id LIMIT 128`,
      [this.namespace, runId]
    );
    return result.rows.map((row) => decode(row.input));
  }

  async snapshot(runId: string): Promise<ExecutionSnapshot | undefined> {
    const result = await this.pool.query(
      'SELECT head, snapshot, fault FROM workflow_execution.runs WHERE namespace=$1 AND run_id=$2',
      [this.namespace, runId]
    );
    if (!result.rows[0]) return undefined;
    try {
      return this.decodeSnapshot(result.rows[0], runId);
    } catch (error) {
      await this.quarantine(runId, {
        code: 'EXECUTION_INVARIANT_VIOLATION',
        message:
          error instanceof Error ? error.message.slice(0, 1000) : String(error),
      });
      throw error;
    }
  }

  private decodeSnapshot(
    row: {
      head: string;
      snapshot: Uint8Array;
      fault: ExecutionSnapshot['fault'];
    },
    runId: string
  ) {
    try {
      const snapshot = ExecutionSnapshotSchema.parse(decode(row.snapshot));
      if (
        snapshot.runId !== runId ||
        snapshot.head !== Number(row.head) ||
        snapshot.tenant.ownerId !== this.namespace
      )
        throw new ExecutionInvariantError(
          'Execution snapshot identity or head disagrees with storage'
        );
      if (row.fault) snapshot.fault = row.fault;
      projectExecutionSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (ExecutionInvariantError.is(error)) throw error;
      throw new ExecutionInvariantError('Malformed execution snapshot');
    }
  }

  async quarantine(
    runId: string,
    fault: NonNullable<ExecutionSnapshot['fault']>
  ) {
    const result = await this.pool.query(
      'UPDATE workflow_execution.runs SET fault=COALESCE(fault,$3::jsonb) WHERE namespace=$1 AND run_id=$2',
      [this.namespace, runId, JSON.stringify(fault)]
    );
    if (!result.rowCount)
      throw new Error('Cannot quarantine a missing execution');
  }

  async receipt(
    runId: string,
    operationId: string
  ): Promise<ExecutionReceipt | undefined> {
    await this.snapshot(runId); // Respect sticky faults, including on duplicate requests.
    const result = await this.pool.query(
      'SELECT receipt FROM workflow_execution.receipts WHERE namespace=$1 AND run_id=$2 AND operation_id=$3',
      [this.namespace, runId, operationId]
    );
    return result.rows[0] ? decode(result.rows[0].receipt) : undefined;
  }

  async create(
    runId: string,
    event: RunCreatedEventRequest
  ): Promise<ExecutionSnapshot> {
    event = CreateEventSchema.parse(event) as RunCreatedEventRequest;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Creation races are exact request deduplication, not competing execution.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify([this.namespace, runId, 'create'])]
      );
      const found = await client.query(
        'SELECT head, snapshot, fault FROM workflow_execution.runs WHERE namespace=$1 AND run_id=$2 FOR UPDATE',
        [this.namespace, runId]
      );
      if (found.rows[0]) {
        const existing = this.decodeSnapshot(found.rows[0], runId);
        if (found.rows[0].fault)
          throw new ExecutionInvariantError(found.rows[0].fault.message);
        const {
          runId: _run,
          eventId: _id,
          createdAt: _time,
          ...first
        } = existing.events[0];
        if (fingerprint(first) !== fingerprint(event)) {
          const fault = {
            code: 'EXECUTION_INVARIANT_VIOLATION',
            message: 'Run ID reused with different creation',
          };
          await client.query(
            'UPDATE workflow_execution.runs SET fault=$3 WHERE namespace=$1 AND run_id=$2',
            [this.namespace, runId, fault]
          );
          await client.query('COMMIT');
          throw new ExecutionInvariantError(fault.message);
        }
        await client.query('COMMIT');
        return existing;
      }
      const snapshot: ExecutionSnapshot = {
        profile: EXECUTION_PROFILE,
        runId,
        deploymentId: event.eventData.deploymentId,
        tenant: {
          ownerId: this.namespace,
          projectId: this.namespace,
          environment: 'postgres',
        },
        head: 1,
        events: [
          {
            ...event,
            runId,
            eventId: `evnt_${'1'.padStart(26, '0')}`,
            createdAt: new Date(),
          },
        ],
      };
      ExecutionSnapshotSchema.parse(snapshot);
      projectExecutionSnapshot(snapshot);
      if (encode(snapshot).byteLength > 4 * 1024 * 1024)
        throw new Error('Execution creation limit exceeded');
      await client.query(
        'INSERT INTO workflow_execution.runs(namespace,run_id,head,snapshot) VALUES($1,$2,1,$3)',
        [this.namespace, runId, encode(snapshot)]
      );
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      if (ExecutionInvariantError.is(error))
        await client.query(
          'UPDATE workflow_execution.runs SET fault=COALESCE(fault,$3::jsonb) WHERE namespace=$1 AND run_id=$2',
          [
            this.namespace,
            runId,
            JSON.stringify({ code: error.code, message: error.message }),
          ]
        );
      throw error;
    } finally {
      client.release();
    }
  }

  async exchange(
    request: ExecutionExchange,
    ownerId: string
  ): Promise<ExecutionReceipt> {
    if (!request.events.length || request.events.length > 32)
      throw new Error('Execution batch requires 1..32 events');
    for (const event of request.events) {
      if (CreateEventSchema.parse(event).eventType === 'run_created')
        throw new ExecutionInvariantError(
          'Creation is not an exchange operation'
        );
      if (encode(event).byteLength > 128 * 1024)
        throw new Error('Execution event limit exceeded');
    }
    const client = await this.pool.connect();
    const hash = fingerprint({
      events: request.events,
      deploymentId: request.deploymentId,
    });
    let locked = false;
    try {
      await client.query('BEGIN');
      const loaded = await client.query(
        'SELECT head,snapshot,fault,owner_id FROM workflow_execution.runs WHERE namespace=$1 AND run_id=$2 FOR UPDATE',
        [this.namespace, request.runId]
      );
      if (!loaded.rows[0]) throw new Error('Execution not found');
      await client.query('SAVEPOINT effects');
      locked = true;
      if (loaded.rows[0].fault)
        throw new ExecutionInvariantError(loaded.rows[0].fault.message);
      if (loaded.rows[0].owner_id !== ownerId)
        throw new ExecutionInvariantError(
          'Exchange does not hold the execution grant'
        );
      const snapshot = this.decodeSnapshot(loaded.rows[0], request.runId);
      const existing = await client.query(
        'SELECT receipt,fingerprint FROM workflow_execution.receipts WHERE namespace=$1 AND run_id=$2 AND operation_id=$3',
        [this.namespace, request.runId, request.operationId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== hash)
          throw new ExecutionInvariantError(
            'Operation ID reused with different content'
          );
        await client.query('COMMIT');
        return decode(existing.rows[0].receipt);
      }
      if (snapshot.head !== request.expectedHead)
        throw new ExecutionInvariantError(
          `Expected head ${request.expectedHead}, observed ${snapshot.head}`
        );
      if (snapshot.deploymentId !== request.deploymentId)
        throw new ExecutionInvariantError('Execution version mismatch');
      projectExecutionSnapshot(snapshot);
      const now = new Date();
      const events: ExecutionReceipt['events'] = [];
      for (const event of request.events) {
        const committed = {
          ...event,
          runId: request.runId,
          eventId: `evnt_${String(snapshot.head + events.length + 1).padStart(26, '0')}`,
          createdAt: now,
        } as ExecutionReceipt['events'][number];
        if (event.eventType === 'hook_created') {
          const binding = await client.query(
            'INSERT INTO workflow_execution.hooks(namespace,token,run_id,hook_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING run_id',
            [
              this.namespace,
              event.eventData.token,
              request.runId,
              event.correlationId,
            ]
          );
          if (!binding.rowCount) {
            const owner = await client.query(
              'SELECT run_id FROM workflow_execution.hooks WHERE namespace=$1 AND token=$2',
              [this.namespace, event.eventData.token]
            );
            if (!owner.rows[0])
              throw new ExecutionInvariantError(
                'Hook conflict owner disappeared'
              );
            events.push({
              ...committed,
              eventType: 'hook_conflict',
              correlationId: event.correlationId,
              eventData: {
                token: event.eventData.token,
                conflictingRunId: owner.rows[0].run_id,
              },
            });
            continue;
          }
        }
        if (event.eventType === 'hook_disposed') {
          await client.query(
            'DELETE FROM workflow_execution.hooks WHERE namespace=$1 AND run_id=$2 AND hook_id=$3',
            [this.namespace, request.runId, event.correlationId]
          );
        }
        events.push(committed);
      }
      const next = {
        ...snapshot,
        head: snapshot.head + events.length,
        events: [...snapshot.events, ...events],
      };
      ExecutionSnapshotSchema.parse(next);
      const nextView = projectExecutionSnapshot(next);
      const encoded = encode(next);
      if (next.head > 1024 || encoded.byteLength > 4 * 1024 * 1024)
        throw new Error('Reference execution journal limit exceeded');
      if (['completed', 'failed', 'cancelled'].includes(nextView.run.status)) {
        await client.query(
          'DELETE FROM workflow_execution.hooks WHERE namespace=$1 AND run_id=$2',
          [this.namespace, request.runId]
        );
      }
      const receipt: ExecutionReceipt = {
        operationId: request.operationId,
        head: next.head,
        events,
      };
      await client.query(
        'UPDATE workflow_execution.runs SET head=$3,snapshot=$4 WHERE namespace=$1 AND run_id=$2',
        [this.namespace, request.runId, next.head, encoded]
      );
      await client.query(
        'INSERT INTO workflow_execution.receipts(namespace,run_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)',
        [
          this.namespace,
          request.runId,
          request.operationId,
          hash,
          encode(receipt),
        ]
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      if (locked && ExecutionInvariantError.is(error)) {
        // Keep the row lock while rolling back effects and recording the fault.
        await client.query('ROLLBACK TO SAVEPOINT effects');
        await client.query(
          'UPDATE workflow_execution.runs SET fault=COALESCE(fault,$3::jsonb) WHERE namespace=$1 AND run_id=$2',
          [
            this.namespace,
            request.runId,
            JSON.stringify({
              code: error.code,
              message: error.message,
              activationId: request.activationId,
            }),
          ]
        );
        await client.query('COMMIT');
      } else await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
