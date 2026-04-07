import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { getEsbuildTsconfigOptions } from './esbuild-tsconfig.js';

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function normalize(paths: string[]): string[] {
  return paths.map((p) => p.replace(/\\/g, '/'));
}

async function buildInputs({
  workingDir,
  tsconfigOptions,
}: {
  workingDir: string;
  tsconfigOptions: { tsconfig?: string; tsconfigRaw?: string };
}): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: workingDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    metafile: true,
    stdin: {
      contents: `import '@/workflows/target'; import '@/app/.well-known/agent/v1/steps';`,
      resolveDir: workingDir,
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
    ...tsconfigOptions,
  });

  return normalize(Object.keys(result.metafile.inputs));
}

describe('getEsbuildTsconfigOptions', () => {
  const createdRoots: string[] = [];
  const symlinkTest = process.platform === 'win32' ? it.skip : it;

  afterEach(() => {
    for (const root of createdRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns tsconfig for regular files', async () => {
    const root = mkdtempSync(join(realTmpdir, 'workflow-tsconfig-regular-'));
    createdRoots.push(root);
    const workingDir = join(root, 'app');
    const tsconfigPath = join(workingDir, 'tsconfig.json');

    writeFile(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            paths: {
              '@/*': ['./*'],
            },
          },
        },
        null,
        2
      )
    );

    const options = await getEsbuildTsconfigOptions(tsconfigPath);
    expect(options).toEqual({ tsconfig: tsconfigPath });
  });

  symlinkTest(
    'uses tsconfigRaw for symlinked configs so aliases resolve from working dir',
    async () => {
      const root = mkdtempSync(join(realTmpdir, 'workflow-tsconfig-symlink-'));
      createdRoots.push(root);
      const workingDir = join(root, 'webpack-app');
      const sourceDir = join(root, 'turbopack-app');
      const symlinkTsconfigPath = join(workingDir, 'tsconfig.json');

      writeFile(
        join(sourceDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '@/*': ['./*'],
              },
            },
          },
          null,
          2
        )
      );

      writeFile(
        join(workingDir, 'workflows/target.ts'),
        'export const id = "webpack";'
      );
      writeFile(
        join(workingDir, 'app/.well-known/agent/v1/steps.ts'),
        'export const id = "webpack-app";'
      );
      writeFile(
        join(sourceDir, 'workflows/target.ts'),
        'export const id = "turbopack";'
      );
      writeFile(
        join(sourceDir, 'app/.well-known/agent/v1/steps.ts'),
        'export const id = "turbopack-app";'
      );

      symlinkSync(
        join(sourceDir, 'tsconfig.json'),
        symlinkTsconfigPath,
        'file'
      );

      const directInputs = await buildInputs({
        workingDir,
        tsconfigOptions: { tsconfig: symlinkTsconfigPath },
      });
      expect(
        directInputs.some((input) =>
          input.includes('turbopack-app/workflows/target.ts')
        )
      ).toBe(true);
      expect(
        directInputs.some((input) =>
          input.includes('turbopack-app/app/.well-known/agent/v1/steps.ts')
        )
      ).toBe(true);

      const options = await getEsbuildTsconfigOptions(symlinkTsconfigPath);
      expect(typeof options.tsconfigRaw).toBe('string');
      expect(options.tsconfig).toBeUndefined();

      const normalizedInputs = await buildInputs({
        workingDir,
        tsconfigOptions: options,
      });

      expect(
        normalizedInputs.some((input) => input.endsWith('workflows/target.ts'))
      ).toBe(true);
      expect(
        normalizedInputs.some((input) =>
          input.endsWith('app/.well-known/agent/v1/steps.ts')
        )
      ).toBe(true);
      expect(
        normalizedInputs.some((input) =>
          input.includes('turbopack-app/workflows/target.ts')
        )
      ).toBe(false);
      expect(
        normalizedInputs.some((input) =>
          input.includes('turbopack-app/app/.well-known/agent/v1/steps.ts')
        )
      ).toBe(false);
    }
  );
});
