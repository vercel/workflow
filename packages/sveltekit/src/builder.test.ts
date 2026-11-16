import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SvelteKitBuilder } from './builder.js';

class TestBuilder extends SvelteKitBuilder {
  get externalPackages() {
    return this.config.externalPackages;
  }
}

const DEFAULT_EXTERNALS = [
  '$env/*',
  '$lib',
  '$lib/*',
  '$app/*',
  '#lib',
  '#lib/*',
];

let workingDir: string;

function expectDefaultExternals(builder: TestBuilder) {
  expect(builder.externalPackages).toEqual(
    expect.arrayContaining(DEFAULT_EXTERNALS)
  );
  expect(builder.externalPackages).toHaveLength(DEFAULT_EXTERNALS.length);
}

async function writePackageJson(contents: string) {
  await writeFile(join(workingDir, 'package.json'), contents);
}

beforeEach(async () => {
  workingDir = await mkdtemp(join(tmpdir(), 'workflow-sveltekit-builder-'));
});

afterEach(async () => {
  await rm(workingDir, { force: true, recursive: true });
});

describe('SvelteKitBuilder', () => {
  it('leaves $lib, $app and $env to Vite', () => {
    const builder = new TestBuilder({ workingDir });

    expect(builder.externalPackages).toEqual(
      expect.arrayContaining(['$env/*', '$lib', '$lib/*', '$app/*'])
    );
  });

  it('leaves #lib subpath imports to Vite like $lib', () => {
    const builder = new TestBuilder({ workingDir });

    expect(builder.externalPackages).toEqual(
      expect.arrayContaining(['#lib', '#lib/*'])
    );
  });

  it("leaves every key of the app's package.json imports to Vite", async () => {
    await writePackageJson(
      JSON.stringify({
        imports: { '#db': './src/db.ts', '#lib/*': './src/lib/*' },
      })
    );

    const builder = new TestBuilder({ workingDir });

    expect(builder.externalPackages).toEqual(
      expect.arrayContaining([...DEFAULT_EXTERNALS, '#db'])
    );
    expect(builder.externalPackages).toHaveLength(DEFAULT_EXTERNALS.length + 1);
  });

  it('keeps the defaults without a package.json', () => {
    expectDefaultExternals(new TestBuilder({ workingDir }));
  });

  it('keeps the defaults when package.json has no imports field', async () => {
    await writePackageJson('{}');

    expectDefaultExternals(new TestBuilder({ workingDir }));
  });

  it('keeps the defaults when package.json is not valid JSON', async () => {
    await writePackageJson('not json');

    expectDefaultExternals(new TestBuilder({ workingDir }));
  });

  it('keeps the defaults when imports is not an object', async () => {
    await writePackageJson(JSON.stringify({ imports: ['#x'] }));

    expectDefaultExternals(new TestBuilder({ workingDir }));
  });

  it('ignores imports keys that do not start with #', async () => {
    await writePackageJson(
      JSON.stringify({ imports: { 'lib/*': './src/lib/*' } })
    );

    expectDefaultExternals(new TestBuilder({ workingDir }));
  });
});
