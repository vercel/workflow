import type { WorkflowRun } from '@workflow/world';
import {
  getEventDataRefFields,
  RETENTION_ATTRIBUTE,
  readRunRetention,
} from '@workflow/world';
import { decode, encode } from '../db.js';
import {
  type Ctx,
  parseHook,
  releaseHookTokenClaimIfOwnedBy,
} from './common.js';

/**
 * Whether a finished run asked for its user data to be deleted now. The
 * decision is `@workflow/world`'s {@link readRunRetention}, shared with every
 * World that implements retention.
 */
export function purgesUserDataOnFinish(
  attributes: Record<string, string> | undefined
): boolean {
  const retention = readRunRetention(attributes);
  if (retention.unsupported) {
    console.warn(
      `[world-sqlite] Ignoring unrecognized ${RETENTION_ATTRIBUTE} value ` +
        `${JSON.stringify(retention.raw)}; keeping the run's data.`
    );
  }
  return retention.mode === 'none';
}

/** The run with its payloads dropped and `expiredAt` set. */
export function withRunPayloadsPurged<T extends WorkflowRun>(
  run: T,
  purgedAt: Date
): T {
  return {
    ...run,
    input: undefined,
    output: undefined,
    error: undefined,
    dynamicWorkflowCode: undefined,
    expiredAt: purgedAt,
  };
}

/**
 * Drops a finished run's payloads from its steps, events and hooks (the run
 * row itself is written purged by the caller). Streams are purged
 * separately. Runs inside the caller's transaction, so the purge is atomic
 * with the terminal transition that asked for it.
 */
export function purgeRunEntityData(ctx: Ctx, runId: string): void {
  const { db } = ctx;
  for (const row of db.all<{ step_id: string; data: Uint8Array }>(
    'SELECT step_id, data FROM steps WHERE run_id = ?',
    runId
  )) {
    const step = decode<Record<string, unknown>>(row.data);
    step.input = undefined;
    step.output = undefined;
    step.error = undefined;
    db.run(
      'UPDATE steps SET data = ? WHERE run_id = ? AND step_id = ?',
      encode(step),
      runId,
      row.step_id
    );
  }
  for (const row of db.all<{ seq: number; data: Uint8Array }>(
    'SELECT seq, data FROM events WHERE run_id = ?',
    runId
  )) {
    const event = decode<Record<string, any>>(row.data);
    const eventData = event.eventData;
    if (!eventData || typeof eventData !== 'object') continue;
    let changed = false;
    const fields: string[] = [
      ...getEventDataRefFields(String(event.eventType)),
    ];
    if (
      event.eventType === 'run_created' ||
      event.eventType === 'run_started'
    ) {
      fields.push('dynamicWorkflowCode', 'dynamicWorkflowCodeRef');
    }
    for (const field of fields) {
      if (field in eventData) {
        delete eventData[field];
        changed = true;
      }
    }
    if (changed) {
      db.run(
        'UPDATE events SET data = ? WHERE run_id = ? AND seq = ?',
        encode(event),
        runId,
        row.seq
      );
    }
  }
  for (const row of db.all<{ hook_id: string; data: Uint8Array }>(
    'SELECT hook_id, data FROM hooks WHERE run_id = ?',
    runId
  )) {
    const hook = decode<Record<string, unknown>>(row.data);
    hook.metadata = undefined;
    db.run(
      'UPDATE hooks SET data = ? WHERE hook_id = ?',
      encode(hook),
      row.hook_id
    );
  }
}

/**
 * Closes a finished run's hooks: each releases its token and is deleted,
 * except one whose token retention (`tokenRetentionUntil`) is still running,
 * which stays so its token stays reserved.
 */
export function deleteAllHooksForRun(ctx: Ctx, runId: string): void {
  const { db } = ctx;
  for (const row of db.all<{ hook_id: string; data: Uint8Array }>(
    'SELECT hook_id, data FROM hooks WHERE run_id = ?',
    runId
  )) {
    let hook: ReturnType<typeof parseHook>;
    try {
      hook = parseHook(row.data);
    } catch {
      continue;
    }
    if (hook.runId !== runId) continue;
    if (
      hook.tokenRetentionUntil &&
      hook.tokenRetentionUntil.getTime() > Date.now()
    ) {
      continue;
    }
    releaseHookTokenClaimIfOwnedBy(ctx, hook.token, hook);
    db.run('DELETE FROM hooks WHERE hook_id = ?', row.hook_id);
  }
}
