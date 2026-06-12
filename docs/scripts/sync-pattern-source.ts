/**
 * sync-pattern-source — derive docs snippet strings from canonical pattern
 * source files.
 *
 * The canonical, executable, *tested* pattern sources live in
 * `workbench/vitest/workflows/patterns/`. This script copies each file's
 * content into `docs/lib/patterns/generated/<name>.ts` as two exports:
 *
 *   - `<camel>FullSource`    — the file verbatim (served by /r installs)
 *   - `<camel>DisplaySource` — the file with its leading header doc-block
 *                              stripped (rendered in the docs Source tab;
 *                              the page already presents the same info as
 *                              structured guide sections)
 *
 * Snippet modules in `docs/lib/patterns/snippets/` import from `generated/`
 * instead of carrying hand-maintained template-literal copies.
 *
 * CI runs this script and fails if `git diff` is dirty afterwards — editing
 * a generated file or letting it drift from canonical is a build error.
 * Run via: `pnpm sync-pattern-source` (from docs/).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalDir = join(
  docsDir,
  '..',
  'workbench',
  'vitest',
  'workflows',
  'patterns'
);
const generatedDir = join(docsDir, 'lib', 'patterns', 'generated');

function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Strip the leading `/** … *\/` header block (and following blank lines). */
function stripHeader(source: string): string {
  const match = source.match(/^\/\*\*[\s\S]*?\*\/\s*\n/);
  if (!match) return source;
  return source.slice(match[0].length);
}

function generate(): void {
  mkdirSync(generatedDir, { recursive: true });

  const files = readdirSync(canonicalDir)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  const index: string[] = [];

  for (const file of files) {
    const name = file.replace(/\.ts$/, '');
    const camel = camelCase(name);
    const source = readFileSync(join(canonicalDir, file), 'utf8');
    const display = stripHeader(source);

    const out = `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: workbench/vitest/workflows/patterns/${file}
 * Regenerate with: pnpm sync-pattern-source (from docs/)
 */

export const ${camel}FullSource = ${JSON.stringify(source)};

export const ${camel}DisplaySource = ${JSON.stringify(display)};
`;
    writeFileSync(join(generatedDir, `${name}.ts`), out);
    index.push(`export * from './${name}';`);
  }

  writeFileSync(
    join(generatedDir, 'index.ts'),
    `/**
 * GENERATED FILE — do not edit. See sync-pattern-source.ts.
 */

${index.join('\n')}
`
  );

  console.log(`Generated ${files.length} pattern source modules.`);
}

generate();
