import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(PACKAGE_ROOT, 'src');
const RAW_TAILWIND_SIZE_PATTERN = /\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/g;

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          return listSourceFiles(path);
        }
        return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
      })
  );
  return nestedFiles.flat();
}

function relativeSourcePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join('/');
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

describe('typography tokens', () => {
  it('rejects text-xs through text-9xl', async () => {
    const files = await listSourceFiles(SOURCE_ROOT);
    const violations = (
      await Promise.all(
        files.map(async (path) => {
          const source = await readFile(path, 'utf8');
          const file = relativeSourcePath(path);
          return Array.from(
            source.matchAll(RAW_TAILWIND_SIZE_PATTERN),
            (match) =>
              `${file}:${lineNumberAt(source, match.index ?? 0)} ${match[0]}`
          );
        })
      )
    ).flat();

    expect(violations).toEqual([]);
  });
});
