import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The modules that read the World through `getWorldLazy()` do so to keep
// `world.ts` - and with it world-local, world-vercel and their dependencies -
// out of the step registrations bundle (see `get-world-lazy.ts`). One static
// import of `world.ts` anywhere below one of them undoes that. So each is
// bundled the way a builder bundles step code, with its packages left
// external, and `world.ts` must not be among its inputs.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = 'runtime/world.ts';
// `world-init.ts` imports `world.ts` on purpose, for its registration.
const MAY_IMPORT_WORLD = new Set([WORLD, 'runtime/world-init.ts']);
const LAZY_IMPORT = /from\s+'\.{1,2}\/(?:runtime\/)?get-world-lazy\.js'/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });

const lazyReaders = sourceFiles(SRC)
  .map((path) => relative(SRC, path))
  .filter(
    (path) =>
      !MAY_IMPORT_WORLD.has(path) &&
      LAZY_IMPORT.test(readFileSync(join(SRC, path), 'utf8'))
  )
  .sort();

// A file the build generates (`version.ts`, the QuickJS assets) is not there
// before the build runs, and imports nothing of this package.
const generatedFilesExternal: Plugin = {
  name: 'generated-files-external',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const target = resolve(args.resolveDir, args.path);
      const candidates = [target, target.replace(/\.js$/, '.ts')];
      return candidates.some((candidate) => existsSync(candidate))
        ? undefined
        : { path: args.path, external: true };
    });
  },
};

const bundledInputs = async (entry: string): Promise<string[]> => {
  const result = await build({
    absWorkingDir: SRC,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    plugins: [generatedFilesExternal],
  });
  return Object.keys(result.metafile.inputs);
};

describe('step-side modules keep world.ts out of their bundle', () => {
  it('finds the modules that read the World lazily', () => {
    expect(lazyReaders).toContain('runtime/helpers.ts');
    expect(lazyReaders).toContain('serialization.ts');
  });

  it('bundles world.ts when a module imports it - the control', async () => {
    expect(await bundledInputs('runtime/world-init.ts')).toContain(WORLD);
  });

  it.each(lazyReaders)('%s does not bundle world.ts', async (entry) => {
    expect(await bundledInputs(entry)).not.toContain(WORLD);
  });
});
