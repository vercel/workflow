import { mkdtemp, rm } from 'node:fs/promises';
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
});
