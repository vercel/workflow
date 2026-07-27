import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard for the invariant that broke o2flow on
 * `workflow@5.0.0-beta.26`: a dynamic `import()`/`require()` whose specifier is
 * not a string literal must carry BOTH the `webpackIgnore` and
 * `turbopackIgnore` magic comments. Without them, webpack and Turbopack replace
 * the call with a throwing stub ("Cannot find module as expression is too
 * dynamic") and the world can never be resolved from that bundle.
 *
 * This is a text check on purpose. The failure mode it guards is invisible to
 * type checking and to any test that runs under Node's own loader — it only
 * appears after a host bundler has processed the file, which no unit test does.
 * See `packages/core/e2e/route-bundle-isolation.test.ts` for the end-to-end
 * counterpart.
 */
const worldSourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'world.ts'
);

/**
 * Matches `import(` / `require(` calls whose first argument is not a string
 * literal, capturing everything between the paren and the argument so the
 * assertion can look for the magic comments in it.
 */
const DYNAMIC_LOAD_RE =
  /(?<![\w$.])(import|require)\(\s*((?:\/\*[\s\S]*?\*\/\s*)*)(?!['"`])([A-Za-z_$][\w$]*)/g;

/**
 * Drop `//` comments and `/** ... *\/` doc blocks so prose *about* dynamic
 * imports isn't mistaken for one. Plain `/* ... *\/` blocks stay — those are
 * the magic comments being asserted on.
 */
function stripProse(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('world.ts bundler safety', () => {
  const source = stripProse(readFileSync(worldSourcePath, 'utf-8'));

  it('keeps webpackIgnore and turbopackIgnore on every non-literal import/require', () => {
    const offenders: string[] = [];

    for (const match of source.matchAll(DYNAMIC_LOAD_RE)) {
      const [, callee, comments, argument] = match;
      // `createRequire(...)` / `getRuntimeRequire()` produce a require
      // function; only the invocation with the world specifier matters.
      if (!comments.includes('webpackIgnore')) {
        offenders.push(`${callee}(${argument}) is missing webpackIgnore`);
      }
      if (!comments.includes('turbopackIgnore')) {
        offenders.push(`${callee}(${argument}) is missing turbopackIgnore`);
      }
    }

    expect(
      offenders,
      'A dynamic import/require in world.ts lost its bundler ignore comments. ' +
        'webpack/Turbopack will replace it with a throwing stub and world ' +
        'resolution will fail inside bundled host routes.'
    ).toEqual([]);
  });

  it('finds the dynamic world load it is meant to be guarding', () => {
    // Cheap canary: if world.ts stops loading the target world dynamically,
    // this test is no longer testing anything and should be revisited rather
    // than passing vacuously.
    const matches = [...source.matchAll(DYNAMIC_LOAD_RE)];
    expect(matches.length).toBeGreaterThan(0);
  });

  it('ships comments in the published build', () => {
    // The magic comments only help if tsc keeps them in dist/.
    const tsconfig = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../tsconfig.json'),
      'utf-8'
    );
    expect(tsconfig).not.toMatch(/"removeComments"\s*:\s*true/);
  });
});
