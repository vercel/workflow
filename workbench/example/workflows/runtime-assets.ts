import { readFileSync } from 'node:fs';

function readRuntimeAssets() {
  'use step';
  const engine = readFileSync(
    new URL(
      './fixtures/runtime-assets/libquery_engine.dylib.node',
      import.meta.url
    ),
    'utf8'
  );
  const schema = readFileSync(
    new URL('./fixtures/runtime-assets/schema.prisma', import.meta.url),
    'utf8'
  );
  return `${engine}|${schema}`;
}

export async function runtimeAssetsWorkflow() {
  'use workflow';
  return readRuntimeAssets();
}
