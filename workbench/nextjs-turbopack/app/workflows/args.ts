const RANDOM_ARG_PLACEHOLDER = '<random-id>';

function resolveRandomArgPlaceholders(value: unknown): unknown {
  if (value === RANDOM_ARG_PLACEHOLDER) {
    return Math.random().toString(36).slice(2);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveRandomArgPlaceholders(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveRandomArgPlaceholders(entry),
      ])
    );
  }

  return value;
}

export function materializeWorkflowArgs(args: unknown[]): unknown[] {
  return args.map((arg) => resolveRandomArgPlaceholders(arg));
}
