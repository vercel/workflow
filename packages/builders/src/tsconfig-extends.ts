import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/** A tsconfig `extends` value as a list: a string, or an array (TypeScript 5.0+). */
export function getTsconfigExtendsSpecifiers(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

export async function resolveTsconfigExtendsPath(
  extendsValue: string,
  tsconfigPath: string
): Promise<string | undefined> {
  const configDir = dirname(tsconfigPath);
  if (extendsValue.startsWith('.') || isAbsolute(extendsValue)) {
    const resolved = isAbsolute(extendsValue)
      ? extendsValue
      : resolve(configDir, extendsValue);
    return findExistingTsconfigPath(resolved);
  }

  // Only a JSON file can be a tsconfig, so skip a package's JS `main`.
  const candidates = extendsValue.endsWith('.json')
    ? [extendsValue]
    : [extendsValue, `${extendsValue}.json`, `${extendsValue}/tsconfig.json`];
  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate, { paths: [configDir] });
      if (resolved.endsWith('.json')) {
        return resolved;
      }
    } catch {}
  }

  return undefined;
}

async function findExistingTsconfigPath(
  candidatePath: string
): Promise<string | undefined> {
  // TypeScript appends `.json` to any path that does not end in it, so
  // `./tsconfig.base` means `./tsconfig.base.json`.
  const candidates = !candidatePath.endsWith('.json')
    ? [
        `${candidatePath}.json`,
        join(candidatePath, 'tsconfig.json'),
        candidatePath,
      ]
    : [candidatePath];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  return undefined;
}
