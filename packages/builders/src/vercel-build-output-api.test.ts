import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VercelBuildOutputAPIBuilder } from './vercel-build-output-api.js';

class TestVercelBuildOutputAPIBuilder extends VercelBuildOutputAPIBuilder {
  constructor(workingDir: string) {
    super({
      buildTarget: 'vercel-build-output-api',
      dirs: ['src'],
      workingDir,
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
    });
  }

  trace(functionDir: string, entrypoints: string[]): Promise<void> {
    return this.traceFunctionDependencies(functionDir, entrypoints);
  }
}

describe('VercelBuildOutputAPIBuilder', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  it('copies traced runtime files into function directories', async () => {
    const tempDir = await mkdtemp(
      join(await realpath(tmpdir()), 'workflow-vercel-boa-')
    );
    tempDirs.push(tempDir);

    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'node_modules/native-package/prebuilds'), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', type: 'module' })
    );
    await writeFile(
      join(tempDir, 'src/step.ts'),
      'import nativePackage from "native-package";\nexport const value = nativePackage;\n'
    );
    await writeFile(
      join(tempDir, 'node_modules/native-package/package.json'),
      JSON.stringify({ name: 'native-package', main: 'index.js' })
    );
    await writeFile(
      join(tempDir, 'node_modules/native-package/index.js'),
      'module.exports = require("./prebuilds/native.node");\n'
    );
    await writeFile(
      join(tempDir, 'node_modules/native-package/prebuilds/native.node'),
      ''
    );

    const functionDir = join(
      tempDir,
      '.vercel/output/functions/.well-known/workflow/v1/step.func'
    );
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(functionDir, 'package.json'),
      JSON.stringify({ type: 'module' })
    );

    const builder = new TestVercelBuildOutputAPIBuilder(tempDir);
    await builder.trace(functionDir, [join(tempDir, 'src/step.ts')]);

    await expect(
      access(
        join(functionDir, 'node_modules/native-package/prebuilds/native.node')
      )
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(functionDir, 'package.json'), 'utf-8')
    ).resolves.toBe(JSON.stringify({ type: 'module' }));
  });
});
