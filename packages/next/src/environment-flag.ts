const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export function parseEnvironmentFlag(
  rawValue: string | undefined
): boolean | undefined {
  const normalizedValue = rawValue?.trim().toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }

  if (FALSE_ENV_VALUES.has(normalizedValue)) {
    return false;
  }

  return true;
}
