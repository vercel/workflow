import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Temporary investigation logs are tagged with this marker in their message
// and must not ship. Built from parts so this file does not match itself.
const MARKER = `[${'diag'}]`;
const packagesDir = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
  });
}

describe('package sources', () => {
  it('carry no temporary diagnostic logs', () => {
    const offenders = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = join(packagesDir, entry.name, 'src');
        try {
          return sourceFiles(src);
        } catch {
          return [];
        }
      })
      .filter((file) => readFileSync(file, 'utf8').includes(MARKER))
      .map((file) => relative(packagesDir, file));
    expect(offenders).toEqual([]);
  });
});
