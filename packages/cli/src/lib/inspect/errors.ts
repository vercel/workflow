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
