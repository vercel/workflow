import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local world is bundled into the flow route even when a build targets
 * Vercel, and framework adapters (e.g. `@sveltejs/adapter-vercel`) trace that
 * route with `@vercel/nft`. nft statically evaluates path-like expressions, so
 * `const tmp = tmpdir()` made it copy the build machine's whole temp directory
 * into the deployed function (#5265).
 */
describe('build-target-mismatch under @vercel/nft', () => {
  let scratch: string;
  let fakeTmp: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'wl-nft-'));
    fakeTmp = path.join(scratch, 'tmp');
    await mkdir(fakeTmp);
    await writeFile(path.join(fakeTmp, 'build-machine-file.txt'), 'x');
    // nft calls os.tmpdir() in this process while it evaluates the module.
    vi.stubEnv('TMPDIR', fakeTmp);
    vi.stubEnv('TEMP', fakeTmp);
    vi.stubEnv('TMP', fakeTmp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  });

  it('does not trace the temp directory into the bundle', async () => {
    expect(os.tmpdir()).toBe(fakeTmp);

    const source = await readFile(
      fileURLToPath(new URL('./build-target-mismatch.ts', import.meta.url)),
      'utf8'
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const moduleDir = path.join(scratch, 'module');
    await mkdir(moduleDir);
    const entry = path.join(moduleDir, 'build-target-mismatch.mjs');
    await writeFile(entry, outputText);

    const base = path.parse(entry).root;
    const { fileList } = await nodeFileTrace([entry], { base });
    const traced = [...fileList].map((file) => path.resolve(base, file));

    expect(traced).toContain(entry);
    expect(
      traced.filter(
        (file) => file === fakeTmp || file.startsWith(`${fakeTmp}${path.sep}`)
      )
    ).toEqual([]);
  });
});
