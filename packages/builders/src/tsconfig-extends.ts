import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Normalizes a tsconfig `extends` value to the list of specifiers it names.
 *
 * TypeScript accepts a single string or, since 5.0, an array of strings, where
 * later entries override earlier ones. Anything else names no base config.
 */
export function getTsconfigExtendsSpecifiers(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

/**
 * Resolves one tsconfig `extends` specifier to the file it names.
 *
 * Relative and absolute paths resolve against the extending config's
 * directory. Anything else is a package specifier, resolved from that
 * directory as a module, then as `<specifier>/tsconfig.json`.
 */
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

  try {
    return require.resolve(extendsValue, { paths: [configDir] });
  } catch {}

  try {
    return require.resolve(`${extendsValue}/tsconfig.json`, {
      paths: [configDir],
    });
  } catch {
    return undefined;
  }
}

async function findExistingTsconfigPath(
  candidatePath: string
): Promise<string | undefined> {
  const candidates =
    extname(candidatePath) === ''
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
