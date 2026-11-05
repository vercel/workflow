import {
  createLogLimiter,
  globalSingleton,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
  verifyQueueAuthKey,
} from '@workflow/utils';
import type { World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { isDynamicWorkflowsEnabled } from './constants.js';

/**
 * Environment variable that turns the queue delivery check off: `off`
 * accepts unauthenticated deliveries on a World in `'loopback'` mode (a
 * trusted network). Anything else, including unset, leaves it on.
 */
export const QUEUE_AUTH_ENV = 'WORKFLOW_QUEUE_AUTH';

/**
 * Whether `world`'s flow route is checked at all. Opt-in: only a World that
 * declares `'loopback'` is; `'skip'` and a World that declares nothing are
 * not.
 */
function isLoopbackChecked(world: Pick<World, 'queueAuthMode'>): boolean {
  return world.queueAuthMode === 'loopback';
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
export function isQueueAuthEnforced(
  world: Pick<World, 'queueAuthMode'>
): boolean {
  if (!isLoopbackChecked(world)) return false;
  return !isQueueAuthOffRequested() || isDynamicWorkflowsEnabled();
}

/**
 * Process-wide, so the route copies of several bundler layers share it: the
 * warning for a World that declares no mode is logged once, and at most once
 * a minute after that (a dev server re-initializing its routes).
 */
const undeclaredModeWarning = () =>
  globalSingleton('@workflow/core//undeclaredQueueAuthModeWarning', 1, () => ({
    limit: createLogLimiter(),
  }));

/**
 * Opt-in leaves such a World unchecked; say so where an operator will see
 * it, with what to do about it.
 */
function warnUndeclaredQueueAuthMode(): void {
  undeclaredModeWarning().limit((routesSinceLastLog) => {
    runtimeLogger.warn(
      'This World declares no queueAuthMode, so the runtime does not ' +
        'authenticate deliveries to the flow route (POST ' +
        '/.well-known/workflow/v1/flow): a request from outside the app can ' +
        'start runs, fail a running one, or re-trigger its steps. Protect that ' +
        'route at the network edge. Declaring a queueAuthMode becomes required ' +
        'in Workflow SDK v6.',
      { routesSinceLastLog }
    );
  });
}

/**
 * Logs, once per queue route, what `WORKFLOW_QUEUE_AUTH` does for `world`:
 * loudly when it turns the check off, and as an error when that is refused
 * because dynamic workflows are enabled. Silent in the default case. A World
 * that declares no mode gets a warning instead, since its flow route is not
 * checked: once, then at most once a minute when routes restart.
 */
export function logQueueAuthSetting(world: Pick<World, 'queueAuthMode'>): void {
  if (world.queueAuthMode === undefined) {
    warnUndeclaredQueueAuthMode();
    return;
  }
  if (!isLoopbackChecked(world)) return;
  const raw = process.env[QUEUE_AUTH_ENV];
  if (isQueueAuthOffRequested()) {
    if (isDynamicWorkflowsEnabled()) {
      runtimeLogger.error(
        `${QUEUE_AUTH_ENV}=off is refused because dynamic workflows are enabled ` +
          '(WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS). Queue deliveries are still ' +
          'authenticated: a delivery that does not carry the app’s queue key ' +
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

/** Why a delivery was refused: it carried no key, or not the app's. */
export type QueueAuthRefusalReason = 'no-key' | 'wrong-key';

export interface QueueAuthRefusal {
  reason: QueueAuthRefusalReason;
  /** The 401 to answer with, marked as the runtime's own refusal. */
  response: Response;
}

/**
 * Checks that a request to the flow route carries the app's queue key,
 * before the handler reads its body or touches any run.
 *
 * Returns `undefined` to let the delivery through, or the refusal to answer
 * with. A refused request is dropped as is: its run id would come from an
 * unverified body, so failing or otherwise writing to that run would hand the
 * forger the very effect the check exists to deny.
 *
 * The 401 carries `QUEUE_AUTH_REFUSED_HEADER` and `QUEUE_AUTH_REFUSED_CODE`,
 * so the sending queue can tell it from a proxy's bare 401: it reloads its
 * key (another process of the app may have written a new one) and retries a
 * few times before giving the message up.
 */
export async function authorizeQueueDelivery(
  world: Pick<World, 'queueAuthMode'>,
  req: Request
): Promise<QueueAuthRefusal | undefined> {
  if (!isQueueAuthEnforced(world)) return undefined;
  const presented = req.headers.get(QUEUE_AUTH_HEADER);
  // The key in memory first; storage only on a mismatch (see
  // `verifyQueueAuthKey`).
  if (await verifyQueueAuthKey(presented)) return undefined;
  return {
    reason: presented ? 'wrong-key' : 'no-key',
    response: Response.json(
      { error: 'Unauthorized queue delivery', code: QUEUE_AUTH_REFUSED_CODE },
      { status: 401, headers: { [QUEUE_AUTH_REFUSED_HEADER]: '1' } }
    ),
  };
}

/**
 * A rate-limited logger for refused deliveries, one per queue route: the
 * first refusal is logged at once, later ones at most once a minute with a
 * count, so a flood of forged requests cannot flood the logs.
 */
export function createQueueAuthRefusalLogger(): () => void {
  const limit = createLogLimiter();
  return () =>
    limit((refusedSinceLastLog) => {
      runtimeLogger.warn(
        'Refused an unauthenticated queue delivery with a 401; no run was touched. ' +
          'Only deliveries sent by this app’s own processes are accepted. If the ' +
          `request came from a trusted network, set ${QUEUE_AUTH_ENV}=off on this app.`,
        { refusedSinceLastLog }
      );
    });
}
