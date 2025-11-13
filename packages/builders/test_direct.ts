import { transform } from '@swc/core';

const source = `import { FatalError } from 'workflow';

async function add(a: number, b: number): Promise<number> {
  'use step';
  return a + b;
}

export async function simple(i: number) {
  'use workflow';
  const a = await add(i, 7);
  return a;
}
`;

const result = await transform(source, {
  filename: 'input.ts',
  swcrc: false,
  jsc: {
    parser: {
      syntax: 'typescript',
      tsx: false,
    },
    target: 'es2022',
    experimental: {
      plugins: [[require.resolve('../swc-plugin-workflow/swc_plugin_workflow.wasm'), { mode: 'workflow' }]],
    },
  },
  sourceMaps: false,
  minify: false,
});

console.log('=== DIRECT SWC TRANSFORM ===');
console.log(result.code);
