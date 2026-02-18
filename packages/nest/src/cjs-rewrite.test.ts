import { describe, expect, it } from 'vitest';
import {
  mapSourceToDistPath,
  rewriteTsImportsInContent,
  TS_IMPORT_REGEX,
} from './cjs-rewrite.js';

describe('TS_IMPORT_REGEX', () => {
  const testRegex = () =>
    new RegExp(TS_IMPORT_REGEX.source, TS_IMPORT_REGEX.flags);

  it('matches named imports from .ts files', () => {
    const s = 'import { foo, bar } from "../src/services/helper.ts";';
    expect(testRegex().test(s)).toBe(true);
  });

  it('matches named imports from .tsx files', () => {
    const s = 'import { foo } from "./components/Widget.tsx";';
    expect(testRegex().test(s)).toBe(true);
  });

  it('matches imports with "as" alias', () => {
    const s = 'import { hasValue as hv } from "../utils.ts";';
    expect(testRegex().test(s)).toBe(true);
  });

  it('does not match imports from node_modules', () => {
    expect(testRegex().test('import { x } from "@workflow/core";')).toBe(false);
  });
});

describe('rewriteTsImportsInContent', () => {
  const opts = {
    outDir: '/proj/.nestjs/workflow',
    workingDir: '/proj',
    distDir: 'dist',
    dirs: ['src'],
  };

  it('rewrites named imports from .ts to require()', () => {
    const content = [
      'import { foo, bar } from "../../src/services/helper.ts";',
      'const x = 1;',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain('require("../../dist/services/helper.js")');
    expect(result).toMatch(/\bfoo\b.*\bbar\b/);
  });

  it('rewrites imports with "as" alias', () => {
    const content = 'import { hasValue as hv } from "../../src/utils.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain('hasValue: hv');
    expect(result).toContain('require("../../dist/utils.js")');
  });

  it('handles .tsx files', () => {
    const content = 'import { Widget } from "../../src/components/Widget.tsx";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain('dist/components/Widget.js');
  });

  it('returns matchCount 0 when no .ts/.tsx imports', () => {
    const content = 'import { x } from "@workflow/core";\nconst y = 1;';
    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(0);
    expect(result).toBe(content);
  });

  it('rewrites multiple imports', () => {
    const content = [
      'import { a } from "../../src/a.ts";',
      'import { b } from "../../src/b.ts";',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(2);
    expect(result).toContain('require("../../dist/a.js")');
    expect(result).toContain('require("../../dist/b.js")');
  });
});

describe('mapSourceToDistPath', () => {
  it('maps src/ path with dirs=["src"]', () => {
    expect(mapSourceToDistPath('src/services/foo.ts', ['src'], 'dist')).toBe(
      'dist/services/foo.js'
    );
  });

  it('maps src/ path with dirs=["src"] for .tsx', () => {
    expect(mapSourceToDistPath('src/components/foo.tsx', ['src'], 'dist')).toBe(
      'dist/components/foo.js'
    );
  });

  it('handles dirs with multiple entries', () => {
    expect(mapSourceToDistPath('src/foo.ts', ['src', 'lib'], 'dist')).toBe(
      'dist/foo.js'
    );
    expect(mapSourceToDistPath('lib/bar.ts', ['src', 'lib'], 'dist')).toBe(
      'dist/bar.js'
    );
  });

  it('handles dirs: ["."] - fallthrough to dist prepend', () => {
    expect(mapSourceToDistPath('services/foo.ts', ['.'], 'dist')).toBe(
      'dist/services/foo.js'
    );
  });

  it('handles dirs: [".", "src"] - src matches first for src/ files', () => {
    expect(mapSourceToDistPath('src/foo.ts', ['.', 'src'], 'dist')).toBe(
      'dist/foo.js'
    );
  });

  it('handles dirs: [".", "src"] - fallthrough for files outside src/', () => {
    expect(mapSourceToDistPath('services/foo.ts', ['.', 'src'], 'dist')).toBe(
      'dist/services/foo.js'
    );
  });

  it('handles path outside all dirs', () => {
    expect(mapSourceToDistPath('other/foo.ts', ['src'], 'dist')).toBe(
      'dist/other/foo.js'
    );
  });
});
