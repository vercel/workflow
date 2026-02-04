'use server';

import fs from 'node:fs';
import path from 'node:path';
import swc from '@swc/core';

// Construct the WASM path directly to avoid Turbopack trying to bundle it
// Use process.cwd() to get project root
const wasmPath = path.join(
  process.cwd(),
  'node_modules/@workflow/swc-plugin/swc_plugin_workflow.wasm'
);
fs.statSync(wasmPath);

export interface TransformResult {
  workflow: { code: string; error?: string };
  step: { code: string; error?: string };
  client: { code: string; error?: string };
}

export async function transformCode(
  sourceCode: string
): Promise<TransformResult> {
  console.log('[Server] WASM path:', wasmPath);

  const modes = ['workflow', 'step', 'client'] as const;
  const results: TransformResult = {
    workflow: { code: '' },
    step: { code: '' },
    client: { code: '' },
  };

  await Promise.all(
    modes.map(async (mode) => {
      try {
        console.log(`[Server] Transforming with mode: ${mode}`);

        const output = await swc.transform(sourceCode, {
          filename: 'input.ts',
          swcrc: false,
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: true,
            },
            target: 'es2022',
            experimental: {
              plugins: [[wasmPath, { mode }]],
            },
          },
          module: {
            type: 'es6',
          },
        });

        results[mode] = { code: output.code };
        console.log(`[Server] Successfully transformed ${mode}`);
      } catch (err) {
        console.error(`[Server] Compilation error for mode ${mode}:`, err);
        const errorMessage =
          err instanceof Error
            ? err.message
            : 'Compilation failed. Check server logs for details.';
        results[mode] = {
          code: '',
          error: errorMessage,
        };
      }
    })
  );

  return results;
}
