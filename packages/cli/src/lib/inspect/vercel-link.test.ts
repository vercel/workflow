import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectLink } from './vercel-link.js';

const ORG = 'team_abc';

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeProjectJson(dir: string, projectId: string, projectName: string) {
  writeJson(join(dir, '.vercel', 'project.json'), {
    projectId,
    orgId: ORG,
    projectName,
  });
}

function writeRepoJson(
  dir: string,
  projects: { id: string; name: string; directory: string }[]
) {
  writeJson(join(dir, '.vercel', 'repo.json'), {
    orgId: ORG,
    remoteName: 'origin',
    projects,
  });
}

describe('getProjectLink', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-vercel-link-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers a subdirectory project.json over a repo-level repo.json', async () => {
    writeRepoJson(root, [{ id: 'prj_root', name: 'root-app', directory: '.' }]);
    const app = join(root, 'apps', 'nuxt');
    writeProjectJson(app, 'prj_nuxt', 'nuxt-app');

    const link = await getProjectLink(app);
    expect(link?.projectId).toBe('prj_nuxt');
    expect(link?.projectName).toBe('nuxt-app');
  });

  it('finds the nearest project.json when walking up from a nested cwd', async () => {
    writeRepoJson(root, [{ id: 'prj_root', name: 'root-app', directory: '.' }]);
    const app = join(root, 'apps', 'nuxt');
    writeProjectJson(app, 'prj_nuxt', 'nuxt-app');
    const nested = join(app, 'server', 'api');
    mkdirSync(nested, { recursive: true });

    const link = await getProjectLink(nested);
    expect(link?.projectId).toBe('prj_nuxt');
  });

  it('picks the repo.json entry whose directory contains cwd', async () => {
    writeRepoJson(root, [
      { id: 'prj_root', name: 'root-app', directory: '.' },
      { id: 'prj_web', name: 'web', directory: 'apps/web' },
      { id: 'prj_docs', name: 'docs', directory: 'apps/docs' },
    ]);
    const docs = join(root, 'apps', 'docs', 'src');
    mkdirSync(docs, { recursive: true });

    const link = await getProjectLink(docs);
    expect(link?.projectId).toBe('prj_docs');
    expect(link?.projectName).toBe('docs');
    expect(link?.projectRootDirectory).toBe('apps/docs');

    const other = join(root, 'packages', 'lib');
    mkdirSync(other, { recursive: true });
    expect((await getProjectLink(other))?.projectId).toBe('prj_root');
  });

  it('does not match a repo.json directory that only shares a name prefix', async () => {
    writeRepoJson(root, [
      { id: 'prj_web', name: 'web', directory: 'apps/web' },
    ]);
    const dir = join(root, 'apps', 'web-admin');
    mkdirSync(dir, { recursive: true });

    expect(await getProjectLink(dir)).toBeNull();
  });

  it('uses repo.json over a project.json at the repo root', async () => {
    writeRepoJson(root, [
      { id: 'prj_web', name: 'web', directory: 'apps/web' },
    ]);
    writeProjectJson(root, 'prj_root', 'root-app');
    const web = join(root, 'apps', 'web');
    mkdirSync(web, { recursive: true });

    expect((await getProjectLink(web))?.projectId).toBe('prj_web');
    expect((await getProjectLink(root))?.projectId).toBe('prj_root');
  });

  it('returns null when nothing is linked', async () => {
    const dir = join(root, 'apps', 'web');
    mkdirSync(dir, { recursive: true });
    expect(await getProjectLink(dir)).toBeNull();
  });
});
