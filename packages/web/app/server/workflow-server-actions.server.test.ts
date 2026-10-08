import type { Hook } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { hookToListItem } from './workflow-server-actions.server';

describe('hookToListItem', () => {
  it('strips the secret token from runtime hook rows', () => {
    const hook: Hook = {
      hookId: 'hook-1',
      runId: 'run-1',
      token: 'secret-token',
      ownerId: 'owner-1',
      projectId: 'project-1',
      environment: 'production',
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      specVersion: 2,
    };

    const listItem = hookToListItem(hook);

    expect(listItem).toEqual({
      hookId: 'hook-1',
      runId: 'run-1',
      ownerId: 'owner-1',
      projectId: 'project-1',
      environment: 'production',
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      specVersion: 2,
    });
    expect('token' in listItem).toBe(false);
  });
});
