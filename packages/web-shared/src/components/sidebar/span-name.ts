import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';

const stringField = (
  record: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const asRecord = (data: unknown): Record<string, unknown> | undefined =>
  data !== null && typeof data === 'object'
    ? (data as Record<string, unknown>)
    : undefined;

/**
 * The machine-readable name a span's entity carries: the step's `stepName`,
 * else the run's `workflowName`. Undefined for hooks and sleeps, which have
 * neither.
 */
export function getSpanEntityName(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  return stringField(record, 'stepName') ?? stringField(record, 'workflowName');
}

/**
 * The title the detail panel shows for a selected span: a hook's token (or
 * its id), else the short name of the step or workflow, else the raw name.
 * Falls back to "Details" when the span carries nothing to name it by.
 */
export function getSpanTitle(data: unknown, resource?: string): string {
  const record = asRecord(data);
  if (!record) return 'Details';
  const hookId = stringField(record, 'hookId');
  if (resource === 'hook') {
    return stringField(record, 'token') ?? hookId ?? 'Details';
  }

  const name = getSpanEntityName(record);
  if (name) {
    return (
      parseStepName(name)?.shortName ??
      parseWorkflowName(name)?.shortName ??
      name
    );
  }
  return hookId ?? 'Details';
}
