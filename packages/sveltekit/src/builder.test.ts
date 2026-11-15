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

let workingDir: string;

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
    await writeFile(
      join(workingDir, 'package.json'),
      JSON.stringify({
        imports: { '#db': './src/db.ts', '#lib/*': './src/lib/*' },
      })
    );

    const builder = new TestBuilder({ workingDir });

    expect(builder.externalPackages).toEqual(
      expect.arrayContaining(['#db', '#lib/*'])
    );
    expect(
      builder.externalPackages?.filter((pkg) => pkg === '#lib/*')
    ).toHaveLength(1);
  });

  it('builds the externals without a package.json imports field', async () => {
    expect(() => new TestBuilder({ workingDir })).not.toThrow();

    await writeFile(join(workingDir, 'package.json'), '{}');
    expect(new TestBuilder({ workingDir }).externalPackages).toEqual([
      '$env/*',
      '$lib',
      '$lib/*',
      '$app/*',
      '#lib',
      '#lib/*',
    ]);

    await writeFile(join(workingDir, 'package.json'), 'not json');
    expect(() => new TestBuilder({ workingDir })).not.toThrow();
  });
});
