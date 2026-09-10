import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import { logger } from '../config/log.js';

const OBSERVABILITY_UPGRADE_REQUIRED_CODE = 'observability-upgrade-required';
const OBSERVABILITY_UPGRADE_REQUIRED_MESSAGE =
  'This workflow observability data is outside your current plan window. Upgrade Observability Plus to view up to 30 days of workflow data.';

const extractErrorCode = (err: Record<string, unknown>): string | undefined => {
  if (err.code && typeof err.code === 'string') {
    return err.code;
  }

  if (err.body && typeof err.body === 'object') {
    const body = err.body as Record<string, unknown>;
    if (body.code && typeof body.code === 'string') {
      return body.code;
    }
    if (body.error && typeof body.error === 'string') {
      return body.error;
    }
  }

  return undefined;
};

export const isObservabilityUpgradeRequiredError = (
  error: unknown
): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;
  return (
    err.status === 402 &&
    extractErrorCode(err) === OBSERVABILITY_UPGRADE_REQUIRED_CODE
  );
};

export const getObservabilityUpgradeRequiredMessage = (): string =>
  OBSERVABILITY_UPGRADE_REQUIRED_MESSAGE;

/**
 * True for a client-side argument rejection from the World
 * (`code: 'INVALID_ARGUMENT'`).
 *
 * These carry no HTTP status because no request was made, which is exactly
 * why they need naming: status-based branches let them fall through to be
 * rethrown as an unhandled exception, which prints nothing.
 */
export const isInvalidArgumentError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'INVALID_ARGUMENT';

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const checkAndHandleVercelAccessError = (
  error: unknown,
  backend?: string
): boolean => {
  if (backend === 'vercel' && error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (err.status === 403) {
      logger.error(VERCEL_403_ERROR_MESSAGE);
      return true;
    }
  }
  return false;
};

/**
 * Report the error classes that are actionable whichever read path produced
 * them: a project-access failure, a plan gate, or an argument the World
 * rejected locally. Returns true when one matched and was logged.
 *
 * Three callers need exactly this set, for the same reason in each case —
 * the message names something the caller can fix, so swallowing it or
 * retrying past it replaces an actionable error with a silent one:
 *
 *   - `handleApiError` composes it with its HTTP-status arms;
 *   - `listSleeps` uses it alone, to decide what it must report rather than
 *     degrade to the event log;
 *   - `workflow cancel` uses it alone, having no fallback at all.
 *
 * One definition rather than three, so the set cannot drift between them.
 */
export const reportActionableApiError = (
  error: unknown,
  backend?: string
): boolean => {
  // Called once: it logs as a side effect when it recognises the error.
  if (checkAndHandleVercelAccessError(error, backend)) {
    return true;
  }
  if (isObservabilityUpgradeRequiredError(error)) {
    logger.error(getObservabilityUpgradeRequiredMessage());
    return true;
  }
  // An argument the World rejected before sending anything. Report it as
  // given: the message already names the method, the parameter, and what it
  // received.
  if (isInvalidArgumentError(error)) {
    logger.error(errorMessage(error));
    return true;
  }
  return false;
};
