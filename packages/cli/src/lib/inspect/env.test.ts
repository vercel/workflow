import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findManifestPath, resolveProjectFromLink } from './env.js';

const link = {
  projectId: 'prj_linked',
  projectName: 'linked-app',
  teamId: 'team_linked',
};

const env = (
  project = '',
  team = '',
  projectName = ''
): Record<string, string> => ({
  WORKFLOW_VERCEL_PROJECT: project,
  WORKFLOW_VERCEL_TEAM: team,
  WORKFLOW_VERCEL_PROJECT_NAME: projectName,
});

describe('resolveProjectFromLink', () => {
  it('uses the link when nothing was given explicitly', () => {
    expect(resolveProjectFromLink(env(), link)).toEqual({
      WORKFLOW_VERCEL_PROJECT: link.projectId,
      WORKFLOW_VERCEL_PROJECT_NAME: link.projectName,
      WORKFLOW_VERCEL_TEAM: link.teamId,
    });
  });

  it('keeps an explicit project slug that differs from the link', () => {
    expect(
      resolveProjectFromLink(env('other-app', 'other-team'), link)
    ).toEqual({
      WORKFLOW_VERCEL_PROJECT: 'other-app',
      WORKFLOW_VERCEL_PROJECT_NAME: 'other-app',
      WORKFLOW_VERCEL_TEAM: 'other-team',
    });
  });

  it('keeps an explicit project ID that differs from the link', () => {
    const resolved = resolveProjectFromLink(
      env('prj_other', 'other-team'),
      link
    );
    expect(resolved.WORKFLOW_VERCEL_PROJECT).toBe('prj_other');
    expect(resolved.WORKFLOW_VERCEL_PROJECT_NAME).toBe('');
    expect(resolved.WORKFLOW_VERCEL_TEAM).toBe('other-team');
  });

  it('keeps an explicit team even when the project matches the link', () => {
    const resolved = resolveProjectFromLink(
      env(link.projectName, 'explicit-team'),
      link
    );
    expect(resolved.WORKFLOW_VERCEL_TEAM).toBe('explicit-team');
  });

  it('resolves the project ID from the link when --project is its slug', () => {
    expect(resolveProjectFromLink(env(link.projectName), link)).toEqual({
      WORKFLOW_VERCEL_PROJECT: link.projectId,
      WORKFLOW_VERCEL_PROJECT_NAME: link.projectName,
      WORKFLOW_VERCEL_TEAM: link.teamId,
    });
  });

  it('fills the project name from the link when --project is its ID', () => {
    const resolved = resolveProjectFromLink(env(link.projectId), link);
    expect(resolved.WORKFLOW_VERCEL_PROJECT).toBe(link.projectId);
    expect(resolved.WORKFLOW_VERCEL_PROJECT_NAME).toBe(link.projectName);
  });

  it('falls back to the linked team when only --project is given', () => {
    const resolved = resolveProjectFromLink(env('other-app'), link);
    expect(resolved.WORKFLOW_VERCEL_PROJECT).toBe('other-app');
    expect(resolved.WORKFLOW_VERCEL_TEAM).toBe(link.teamId);
  });

  it('keeps an explicit project name', () => {
    const resolved = resolveProjectFromLink(
      env('prj_other', 'team', 'other-app'),
      link
    );
    expect(resolved.WORKFLOW_VERCEL_PROJECT_NAME).toBe('other-app');
  });
});

describe('findManifestPath', () => {
  const tmpDirs: string[] = [];
  const makeProject = async (files: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-cli-manifest-'));
    tmpDirs.push(dir);
    for (const file of files) {
      await mkdir(join(dir, dirname(file)), { recursive: true });
      await writeFile(join(dir, file), '{}');
    }
    return dir;
  };

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  it('prefers the manifest at the app root', async () => {
    const dir = await makeProject([
      'app/.well-known/workflow/v1/manifest.json',
      'app/dashboard/.well-known/workflow/v1/manifest.json',
    ]);
    expect(await findManifestPath(dir)).toBe(
      resolve(dir, 'app/.well-known/workflow/v1/manifest.json')
    );
  });

  it.each([
    'app/dashboard/.well-known/workflow/v1/manifest.json',
    'app/team/flows/.well-known/workflow/v1/manifest.json',
    'src/app/dashboard/.well-known/workflow/v1/manifest.json',
  ])('finds a manifest generated below a route prefix: %s', async (file) => {
    const dir = await makeProject([file]);
    expect(await findManifestPath(dir)).toBe(resolve(dir, file));
  });

  it('ignores node_modules and dot directories', async () => {
    const dir = await makeProject([
      'app/node_modules/pkg/.well-known/workflow/v1/manifest.json',
      'app/.next/server/.well-known/workflow/v1/manifest.json',
    ]);
    expect(await findManifestPath(dir)).toBeUndefined();
  });

  it('does not descend below another .well-known directory', async () => {
    const dir = await makeProject([
      'app/.well-known/agent/.well-known/workflow/v1/manifest.json',
    ]);
    expect(await findManifestPath(dir)).toBeUndefined();
  });
});
