import {
  createLogLimiter,
  globalSingleton,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
  QUEUE_ROUTE_DENIED_CODE,
  verifyQueueAuthKey,
} from '@workflow/utils';
import type { World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { isDynamicWorkflowsEnabled } from './constants.js';

/**
 * Environment variable that turns the flow route's check off: `off` accepts
 * unauthenticated deliveries on a World in `'loopback'` mode (a trusted
 * network), and makes the route of a `'deny'` World accept HTTP again (an
 * emergency override; see {@link isQueueRouteDenied}). Anything else,
 * including unset, leaves the check on.
 */
export const QUEUE_AUTH_ENV = 'WORKFLOW_QUEUE_AUTH';

type QueueAuthWorld = Pick<World, 'queueAuthMode'>;

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
 * Whether `WORKFLOW_QUEUE_AUTH=off` is in force: requested, and not refused
 * because dynamic workflows are enabled (a forged delivery could then
 * execute stored dynamic code). Read on every call, so neither setting can
 * be captured once and outlive a change.
 */
function isQueueAuthOff(): boolean {
  return isQueueAuthOffRequested() && !isDynamicWorkflowsEnabled();
}

/**
 * Whether the flow route refuses every HTTP request: the World declares
 * `'deny'` (it delivers in process; the route has no caller over HTTP, in
 * any process, whether or not this one registered the handler), and the
 * emergency override is not in force.
 */
export function isQueueRouteDenied(world: QueueAuthWorld): boolean {
  return world.queueAuthMode === 'deny' && !isQueueAuthOff();
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
  return !isQueueAuthOff();
}

/**
 * The queue auth log lines' limiters, process-wide rather than per
 * workflowEntrypoint(): several bundler layers each build their own route,
 * and SvelteKit and Astro build a new one for every request, so a limiter
 * held by the route would let every request log. Each line is logged once,
 * then at most once a minute, with the number of calls since.
 */
const settingLogs = () =>
  globalSingleton('@workflow/core//queueAuthSettingLogs', 2, () => ({
    off: createLogLimiter(),
    denyOff: createLogLimiter(),
    refusedOff: createLogLimiter(),
    unrecognized: createLogLimiter(),
  }));

const refusalLog = () =>
  globalSingleton('@workflow/core//queueAuthRefusalLog', 1, () => ({
    limit: createLogLimiter(),
  }));

/**
 * The warning for a World that declares no mode: once, then at most once a
 * minute (a dev server re-initializing its routes, a per-request route).
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
  const denies = world.queueAuthMode === 'deny';
  if (!isLoopbackChecked(world) && !denies) return;
  const raw = process.env[QUEUE_AUTH_ENV];
  const log = settingLogs();
  if (isQueueAuthOffRequested()) {
    if (isDynamicWorkflowsEnabled()) {
      log.refusedOff((routesSinceLastLog) =>
        runtimeLogger.error(
          `${QUEUE_AUTH_ENV}=off is refused because dynamic workflows are enabled ` +
            '(WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS). ' +
            (denies
              ? 'The flow route still accepts no HTTP request: a delivery over HTTP is refused with a 403.'
              : 'Queue deliveries are still authenticated: a delivery that does not carry the app’s queue key is refused with a 401.'),
          { routesSinceLastLog }
        )
      );
      return;
    }
    if (denies) {
      log.denyOff((routesSinceLastLog) =>
        runtimeLogger.warn(
          `THE FLOW ROUTE ACCEPTS HTTP REQUESTS (${QUEUE_AUTH_ENV}=off). This World ` +
            'delivers in process and its route (POST /.well-known/workflow/v1/flow) ' +
            'would otherwise refuse every HTTP request; with the override, anyone who ' +
            'can reach this server can start runs, fail a running one, or re-trigger ' +
            'its steps. This is an emergency override, for a rolling upgrade whose ' +
            'old workers still deliver over HTTP: remove it once they are drained.',
          { routesSinceLastLog }
        )
      );
      return;
    }
    log.off((routesSinceLastLog) =>
      runtimeLogger.warn(
        `QUEUE DELIVERY AUTHENTICATION IS OFF (${QUEUE_AUTH_ENV}=off). The workflow ` +
          'queue routes accept unauthenticated requests: anyone who can reach this ' +
          'server can start runs, fail a running one, or re-trigger its steps. Only ' +
          'use this for local development or on a trusted network.',
        { routesSinceLastLog }
      )
    );
    return;
  }
  if (
    raw !== undefined &&
    raw.trim() !== '' &&
    raw.trim().toLowerCase() !== 'on'
  ) {
    log.unrecognized((routesSinceLastLog) =>
      runtimeLogger.warn(
        `Unrecognized ${QUEUE_AUTH_ENV} value "${raw}"; expected "on" or "off". ` +
          'Queue deliveries stay authenticated.',
        { routesSinceLastLog }
      )
    );
  }
}

/**
 * Why a delivery was refused: it carried no key, or not the app's
 * (`'loopback'`), or the route accepts no HTTP at all (`'deny'`).
 */
export type QueueAuthRefusalReason = 'no-key' | 'wrong-key' | 'denied';

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
  world: QueueAuthWorld,
  req: Request
): Promise<QueueAuthRefusal | undefined> {
  if (isQueueRouteDenied(world)) {
    // Final, unlike the 401 below: no key would make the route accept the
    // request, so a sender must not retry it. Unmarked for the same reason:
    // the marker tells a `'loopback'` sender to reload its key and retry.
    return {
      reason: 'denied',
      response: Response.json(
        {
          error:
            'This route accepts no HTTP requests: the World delivers workflow messages in process',
          code: QUEUE_ROUTE_DENIED_CODE,
        },
        { status: 403 }
      ),
    };
  }
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

const denialLog = () =>
  globalSingleton('@workflow/core//queueRouteDenialLog', 1, () => ({
    limit: createLogLimiter(),
  }));

/**
 * A rate-limited logger for refused deliveries, shared by every route in the
 * process (see `settingLogs`): the first refusal is logged at once, later
 * ones at most once a minute with a count, so a flood of forged requests
 * cannot flood the logs, whether the route is built once or per request. A
 * `'denied'` refusal has its own line and limiter: what to do about it is
 * different.
 */
export function createQueueAuthRefusalLogger(): (
  reason?: QueueAuthRefusalReason
) => void {
  return (reason) => {
    if (reason === 'denied') {
      denialLog().limit((refusedSinceLastLog) => {
        runtimeLogger.warn(
          'Refused an HTTP request to the flow route with a 403: this World ' +
            'delivers workflow messages in process, and the route accepts no HTTP ' +
            'request. No run was touched. During a rolling upgrade the sender is ' +
            'usually a worker on an earlier release, which still delivers over ' +
            'HTTP: each of its deliveries is refused and retried, and every retry ' +
            'counts toward the attempt limit, until that worker is drained. Drain ' +
            'old workers before upgrading. As an emergency override, ' +
            `${QUEUE_AUTH_ENV}=off makes this route accept HTTP again (refused ` +
            'while dynamic workflows are enabled); remove it once the old workers ' +
            'are gone.',
          { refusedSinceLastLog }
        );
      });
      return;
    }
    refusalLog().limit((refusedSinceLastLog) => {
      runtimeLogger.warn(
        'Refused a queue delivery with a 401: it did not carry the app’s current ' +
          'queue key. No run was touched. Right after the app, the CLI or a script ' +
          'starts, this is expected: it wrote a new key, and the sender reloads it ' +
          'and retries on its own. If refusals persist, the sender cannot get the ' +
          'app’s key (another data directory, user or release); only then, and on ' +
          `a trusted network only, set ${QUEUE_AUTH_ENV}=off on this app.`,
        { refusedSinceLastLog }
      );
    });
  };
}
