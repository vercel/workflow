import { describe, expect, it } from 'vitest';
import { resolveProjectFromLink } from './env.js';

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
