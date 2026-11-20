import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeGeneratedDir } from './remove-generated-dir.js';

describe('removeGeneratedDir', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workflow-remove-generated-'));
    dir = join(root, 'static/.well-known/workflow/v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"version":"1.0.0"}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a directory carrying the generated marker', async () => {
    writeFileSync(join(dir, '.gitignore'), '*');

    await removeGeneratedDir(dir);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, 'static'))).toBe(true);
  });

  it('keeps a hand-written directory without a marker', async () => {
    await removeGeneratedDir(dir);

    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });

  it('keeps a directory whose .gitignore was written by hand', async () => {
    writeFileSync(join(dir, '.gitignore'), '*.log\n');

    await removeGeneratedDir(dir);

    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });

  it('does nothing when the directory does not exist', async () => {
    await expect(
      removeGeneratedDir(join(root, 'missing'))
    ).resolves.toBeUndefined();
  });
});
