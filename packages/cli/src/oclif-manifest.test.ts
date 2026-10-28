import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Config } from '@oclif/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

// The published package ships oclif.manifest.json, but a checkout never holds
// one. Lay out a package root the way it is published (manifest next to
// `dist`) in a temp dir, so the manifest path that every installed CLI takes
// is tested without writing into the checkout. Needs `dist`, which turbo
// builds before `test`.
describe('oclif manifest', () => {
  let packageRoot: string;

  beforeAll(async () => {
    packageRoot = await mkdtemp(join(tmpdir(), 'workflow-cli-manifest-'));
    await copyFile(
      join(root, 'package.json'),
      join(packageRoot, 'package.json')
    );
    for (const dir of ['dist', 'node_modules']) {
      await symlink(join(root, dir), join(packageRoot, dir), 'junction');
    }
    await execFileAsync(process.execPath, [
      join(root, 'scripts', 'generate-oclif-manifest.mjs'),
      packageRoot,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (packageRoot) {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('lists every command in src/commands', async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'oclif.manifest.json'), 'utf8')
    );
    const sourceIds = (await readdir(join(root, 'src', 'commands')))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => file.slice(0, -'.ts'.length))
      .sort();

    expect(Object.keys(manifest.commands).sort()).toEqual(sourceIds);
  });

  it('loads every command through the manifest', async () => {
    const config = await Config.load(packageRoot);
    const plugin = config.plugins.get(config.pjson.name);
    expect(plugin?.hasManifest).toBe(true);

    const ids = plugin?.commandIDs ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const command = await config.findCommand(id, { must: true }).load();
      expect(command.id).toBe(id);
    }
  }, 60_000);
});
