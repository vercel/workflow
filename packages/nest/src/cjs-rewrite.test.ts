import { describe, expect, it } from 'vitest';
import {
  mapSourceToDistPath,
  rewriteTsImportsInContent,
} from './cjs-rewrite.js';

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

  it('rewrites multiline named imports', () => {
    const content = [
      'import {',
      '  foo,',
      '  bar as renamedBar,',
      '} from "../../src/services/helper.ts";',
      'const x = foo;',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain(
      'const { foo, bar: renamedBar } = require("../../dist/services/helper.js");'
    );
    expect(result).toContain('const x = foo;');
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

  it('rewrites default imports through a module binding', () => {
    const content = 'import helper from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain(
      'const __workflow_cjs_import_0 = require("../../dist/services/helper.js");'
    );
    expect(result).toContain(
      'const helper = __workflow_cjs_import_0 != null && Object.prototype.hasOwnProperty.call(__workflow_cjs_import_0, "default") ? __workflow_cjs_import_0.default : __workflow_cjs_import_0;'
    );
  });

  it('rewrites mixed default and named imports', () => {
    const content =
      'import helper, { foo, bar as renamedBar } from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain(
      'const __workflow_cjs_import_0 = require("../../dist/services/helper.js");'
    );
    expect(result).toContain(
      'const helper = __workflow_cjs_import_0 != null && Object.prototype.hasOwnProperty.call(__workflow_cjs_import_0, "default") ? __workflow_cjs_import_0.default : __workflow_cjs_import_0;'
    );
    expect(result).toContain(
      'const { foo, bar: renamedBar } = __workflow_cjs_import_0;'
    );
  });

  it('rewrites namespace imports', () => {
    const content = 'import * as helper from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      'const __workflow_cjs_import_0 = require("../../dist/services/helper.js");\n' +
        'const helper = __workflow_cjs_import_0;'
    );
  });

  it('rewrites side-effect imports', () => {
    const content = 'import "../../src/setup.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe('require("../../dist/setup.js");');
  });

  it('rewrites imports after non-ascii content', () => {
    const content = [
      '// 你好',
      'import { foo } from "../../src/services/helper.ts";',
      'const x = foo;',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      [
        '// 你好',
        'const { foo } = require("../../dist/services/helper.js");',
        'const x = foo;',
      ].join('\n')
    );
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

  it('does not rewrite non-relative imports', () => {
    const content = 'import { x } from "@workflow/core";';

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

  it('handles a leading shebang line', () => {
    const content = [
      '#!/usr/bin/env node',
      'import { foo } from "../../src/services/helper.ts";',
      'const x = foo;',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      [
        '#!/usr/bin/env node',
        'const { foo } = require("../../dist/services/helper.js");',
        'const x = foo;',
      ].join('\n')
    );
  });

  it('handles a shebang followed by a leading comment', () => {
    const content = [
      '#!/usr/bin/env node',
      '// banner',
      'import { foo } from "../../src/services/helper.ts";',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      [
        '#!/usr/bin/env node',
        '// banner',
        'const { foo } = require("../../dist/services/helper.js");',
      ].join('\n')
    );
  });

  it('handles a UTF-8 BOM at the start of the file', () => {
    const content = '﻿import { foo } from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      '﻿const { foo } = require("../../dist/services/helper.js");'
    );
  });

  it('handles CRLF line endings', () => {
    const content =
      '// banner\r\nimport { foo } from "../../src/services/helper.ts";\r\nconst x = foo;';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toBe(
      '// banner\r\nconst { foo } = require("../../dist/services/helper.js");\r\nconst x = foo;'
    );
  });

  it('does not rewrite dynamic imports', () => {
    const content = 'const m = import("../../src/dynamic.ts");';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(0);
    expect(result).toBe(content);
  });

  it('rewrites empty named imports as a side-effect require', () => {
    const content = 'import {} from "../../src/setup.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain('require("../../dist/setup.js")');
  });

  it('rewrites a `default as` named import', () => {
    const content =
      'import { default as helper } from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain(
      'const { default: helper } = require("../../dist/services/helper.js");'
    );
  });

  it('rewrites combined default + namespace imports', () => {
    const content =
      'import helper, * as helperNs from "../../src/services/helper.ts";';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(1);
    expect(result).toContain(
      'const __workflow_cjs_import_0 = require("../../dist/services/helper.js");'
    );
    expect(result).toContain(
      'const helper = __workflow_cjs_import_0 != null && Object.prototype.hasOwnProperty.call(__workflow_cjs_import_0, "default") ? __workflow_cjs_import_0.default : __workflow_cjs_import_0;'
    );
    expect(result).toContain('const helperNs = __workflow_cjs_import_0;');
  });

  it('rewrites two imports of the same module without name collisions', () => {
    const content = [
      'import a from "../../src/x.ts";',
      'import b from "../../src/x.ts";',
    ].join('\n');

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(2);
    expect(result).toContain('__workflow_cjs_import_0');
    expect(result).toContain('__workflow_cjs_import_1');
  });

  it('does not rewrite an import-shaped substring inside a template literal', () => {
    const content = 'const s = `import { foo } from "../../src/x.ts";`;';

    const { content: result, matchCount } = rewriteTsImportsInContent(
      content,
      opts
    );

    expect(matchCount).toBe(0);
    expect(result).toBe(content);
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
