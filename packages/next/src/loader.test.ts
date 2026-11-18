import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getLoaderSourceMapOptions,
  inlineEntryRegistrationCode,
} from './loader.ts';

describe('getLoaderSourceMapOptions', () => {
  it('emits source maps for app files and uses the upstream source map', () => {
    const upstreamMap = { version: 3, sources: ['input.ts'], mappings: '' };

    expect(
      getLoaderSourceMapOptions(
        join(process.cwd(), 'app', 'workflow.ts'),
        upstreamMap
      )
    ).toEqual({
      inputSourceMap: upstreamMap,
      sourceMaps: true,
      inlineSourcesContent: true,
    });
  });

  it('disables implicit input source map loading when app files have no upstream map', () => {
    expect(
      getLoaderSourceMapOptions(join(process.cwd(), 'app', 'workflow.ts'), null)
    ).toEqual({
      inputSourceMap: false,
      sourceMaps: true,
      inlineSourcesContent: true,
    });
  });

  it('does not emit source maps for node_modules files', () => {
    expect(
      getLoaderSourceMapOptions(
        join(
          process.cwd(),
          'node_modules',
          '.pnpm',
          'pkg@1.0.0',
          'node_modules',
          'pkg',
          'dist',
          'index.js'
        ),
        { version: 3, sources: ['index.js'], mappings: '' }
      )
    ).toEqual({
      inputSourceMap: false,
      sourceMaps: false,
      inlineSourcesContent: false,
    });
  });
});

describe('inlineEntryRegistrationCode', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wkf-inline-')));
  const source = join(dir, 'workflows', 'order.ts');
  const entry = join(
    dir,
    'app/.well-known/workflow/v1/flow/inline/order-0123456789.js'
  );
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      [source]: {
        entry,
        workflowIds: ['workflow//./workflows/order//placeOrder'],
        stepIds: [],
      },
    })
  );
  const compiled =
    'placeOrder.workflowId = "workflow//./workflows/order//placeOrder";';

  it("registers a lazy import of the module's own entry, for Node.js server code only", () => {
    const code = inlineEntryRegistrationCode(compiled, source, manifestPath);
    expect(code).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(code).toContain(
      'import("../app/.well-known/workflow/v1/flow/inline/order-0123456789.js")'
    );
    expect(code).toContain(
      '.set("workflow//./workflows/order//placeOrder", __wkf_inline_load)'
    );
  });

  it('adds nothing to a module the manifest does not list, or without a manifest', () => {
    expect(
      inlineEntryRegistrationCode(compiled, join(dir, 'other.ts'), manifestPath)
    ).toBeUndefined();
    expect(
      inlineEntryRegistrationCode(compiled, source, undefined)
    ).toBeUndefined();
    expect(
      inlineEntryRegistrationCode(compiled, source, join(dir, 'missing.json'))
    ).toBeUndefined();
  });

  it('adds nothing to a listed module whose compiled code has no workflow', () => {
    expect(
      inlineEntryRegistrationCode('export const x = 1;', source, manifestPath)
    ).toBeUndefined();
  });
});
