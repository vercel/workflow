import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as worldExports from './index.js';
import { zodJsonSchema } from './shared.js';

function isSchemaEntry(entry: [string, unknown]): entry is [string, z.ZodType] {
  const value = entry[1];
  return typeof value === 'object' && value !== null && '_zod' in value;
}

const publicSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(worldExports).filter(isSchemaEntry)
);

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeSourceDirectories = [
  'packages/world/src',
  'packages/world-local/src',
  'packages/world-postgres/src',
  'packages/world-testing/src',
  'packages/world-testing/workflows',
  'packages/world-vercel/src',
].map((directory) => join(repositoryRoot, directory));

function listRuntimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listRuntimeSourceFiles(path);
    if (!/\.[cm]?tsx?$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

const zodRuntimeModules = runtimeSourceDirectories
  .flatMap(listRuntimeSourceFiles)
  .filter((path) =>
    readFileSync(path, 'utf8').includes("import * as z from 'zod';")
  )
  .map((path) => ({
    label: relative(repositoryRoot, path),
    path,
  }));

describe('schema compilation', () => {
  it.each(
    Object.entries(publicSchemas)
  )('precompiles public schema $0', (_name, schema) => {
    expect(schema._zod.bag.validator).toBeTypeOf('function');
  });

  it.each(zodRuntimeModules)('explicitly compiles supported roots in $label', ({
    path,
  }) => {
    const source = readFileSync(path, 'utf8');
    const directSchemaDeclaration =
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)[^\n=]*=\s*z\s*\.(?!compile\b)/gm;
    const derivedSchemaDeclaration =
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*Schema)\b[^\n=]*=\s*[A-Za-z_$][\w$]*Schema\s*\.(?!options\b)/gm;
    const uncompiledRoots = [
      ...source.matchAll(directSchemaDeclaration),
      ...source.matchAll(derivedSchemaDeclaration),
    ].map((match) => match[1]);

    const unsupportedRoots =
      path === join(repositoryRoot, 'packages/world/src/shared.ts')
        ? ['zodJsonSchema']
        : [];
    expect(uncompiledRoots).toEqual(unsupportedRoots);
    expect(source).not.toContain("'zod/compile'");
    expect(source).not.toContain('"zod/compile"');
  });

  it('does not enable compilation for consumer-owned schemas', () => {
    const consumerSchema = z.object({ value: z.string() });
    expect(consumerSchema._zod.bag.validator).toBeUndefined();
    consumerSchema.parse({ value: 'ok' });
    expect(consumerSchema._zod.bag.validator).toBeUndefined();
  });

  it('does not compile schemas passed to the paginated response factory', () => {
    let refinementCalls = 0;
    const consumerSchema = z.string().refine(() => {
      refinementCalls++;
      return false;
    });
    const responseSchema = worldExports.PaginatedResponseSchema(consumerSchema);

    expect(responseSchema._zod.bag.validator).toBeUndefined();
    responseSchema.safeParse({
      data: ['invalid'],
      cursor: null,
      hasMore: false,
    });
    expect(refinementCalls).toBe(1);
  });

  it('keeps the unsupported recursive JSON schema on the runtime parser', () => {
    expect(zodJsonSchema._zod.bag.validator).toBeUndefined();
    expect(zodJsonSchema.parse({ nested: ['value', 1, true, null] })).toEqual({
      nested: ['value', 1, true, null],
    });
  });
});
