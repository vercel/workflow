import { isQueueAuthKey, QUEUE_AUTH_HEADER } from '@workflow/utils';
import type { QueueAuthMode, World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { isDynamicWorkflowsEnabled } from './constants.js';

/**
 * Environment variable that turns the queue delivery check off: `off`
 * accepts unauthenticated deliveries on a World in `'in-process-key'` mode
 * (local development, a trusted network, or a sender in another process).
 * Anything else, including unset, leaves it on.
 */
export const QUEUE_AUTH_ENV = 'WORKFLOW_QUEUE_AUTH';

/** A World that declares no mode fails closed: its deliveries are checked. */
function queueAuthModeOf(world: Pick<World, 'queueAuth'>): QueueAuthMode {
  return world.queueAuth ?? 'in-process-key';
}

function isQueueAuthOffRequested(): boolean {
  return process.env[QUEUE_AUTH_ENV]?.trim().toLowerCase() === 'off';
}

/**
 * Whether deliveries to `world`'s queue routes must carry the process's
 * queue auth key. Reads the environment on every call, so neither setting can
 * be captured once and outlive a change: `WORKFLOW_QUEUE_AUTH=off` is refused
 * while dynamic workflows are enabled, because a forged delivery could then
 * execute stored dynamic code.
 */
export function isQueueAuthEnforced(world: Pick<World, 'queueAuth'>): boolean {
  if (queueAuthModeOf(world) === 'skip') return false;
  return !isQueueAuthOffRequested() || isDynamicWorkflowsEnabled();
}

/**
 * Logs, once per queue route, what `WORKFLOW_QUEUE_AUTH` does for `world`:
 * loudly when it turns the check off, and as an error when that is refused
 * because dynamic workflows are enabled. Silent in the default case.
 */
export function logQueueAuthSetting(world: Pick<World, 'queueAuth'>): void {
  if (queueAuthModeOf(world) === 'skip') return;
  const raw = process.env[QUEUE_AUTH_ENV];
  if (isQueueAuthOffRequested()) {
    if (isDynamicWorkflowsEnabled()) {
      runtimeLogger.error(
        `${QUEUE_AUTH_ENV}=off is refused because dynamic workflows are enabled ` +
          '(WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS). Queue deliveries are still ' +
          'authenticated: a delivery that does not carry this process’s queue key ' +
          'is refused with a 401.'
      );
      return;
    }
    runtimeLogger.warn(
      `QUEUE DELIVERY AUTHENTICATION IS OFF (${QUEUE_AUTH_ENV}=off). The workflow ` +
        'queue routes accept unauthenticated requests: anyone who can reach this ' +
        'server can start runs, fail a running one, or re-trigger its steps. Only ' +
        'use this for local development or on a trusted network.'
    );
    return;
  }
  if (
    raw !== undefined &&
    raw.trim() !== '' &&
    raw.trim().toLowerCase() !== 'on'
  ) {
    runtimeLogger.warn(
      `Unrecognized ${QUEUE_AUTH_ENV} value "${raw}"; expected "on" or "off". ` +
        'Queue deliveries stay authenticated.'
    );
  }
}

/**
 * Checks that a request to a queue route is a delivery from this process's
 * own queue, before the handler reads its body or touches any run.
 *
 * Returns `undefined` to let the delivery through, or the 401 response to
 * answer with. A refused request is dropped as is: its run id would come from
 * an unverified body, so failing or otherwise writing to that run would hand
 * the forger the very effect the check exists to deny.
 */
export function authorizeQueueDelivery(
  world: Pick<World, 'queueAuth'>,
  req: Request
): Response | undefined {
  if (!isQueueAuthEnforced(world)) return undefined;
  if (isQueueAuthKey(req.headers.get(QUEUE_AUTH_HEADER))) return undefined;
  return Response.json(
    { error: 'Unauthorized queue delivery' },
    { status: 401 }
  );
}

/** At most one refusal log per this many milliseconds per queue route. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;

/**
 * A rate-limited logger for refused deliveries, one per queue route: the
 * first refusal is logged at once, later ones at most once a minute with a
 * count, so a flood of forged requests cannot flood the logs.
 */
export function createQueueAuthRefusalLogger(
  world: Pick<World, 'queueAuth'>
): () => void {
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return () => {
    const now = Date.now();
    if (now - lastLoggedAt < REFUSAL_LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }
    lastLoggedAt = now;
    const refusedSinceLastLog = suppressed + 1;
    suppressed = 0;
    runtimeLogger.warn(
      'Refused an unauthenticated queue delivery with a 401; no run was touched. ' +
        'Only deliveries sent by this process’s own queue are accepted. If the ' +
        'request came from a separate process (a script, CLI, or test runner) on a ' +
        `trusted network, set ${QUEUE_AUTH_ENV}=off on this app.` +
        (world.queueAuth === undefined
          ? ' This World declares no `queueAuth` mode, so it is checked by default; ' +
            "a World whose transport authenticates deliveries itself declares `queueAuth: 'skip'`."
          : ''),
      { refusedSinceLastLog }
    );
  };
}
