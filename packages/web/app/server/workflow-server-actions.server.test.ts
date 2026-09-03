import type { AnalyticsEvent, Hook } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsEventToEvent,
  getPublicServerConfig,
  hookToListItem,
} from './workflow-server-actions.server';

const makeAnalyticsEvent = (
  overrides: Partial<AnalyticsEvent>
): AnalyticsEvent => ({
  runId: 'run-1',
  eventId: 'event-1',
  eventType: 'wait_created',
  correlationId: 'wait-1',
  entityId: 'wait-1',
  stepName: null,
  workflowName: 'workflow//./src/workflows/test//myWorkflow',
  deploymentId: 'dep-1',
  specVersion: 2,
  runCreatedAt: new Date('2026-06-30T00:00:00.000Z'),
  createdAt: new Date('2026-06-30T00:00:01.000Z'),
  region: null,
  vercelId: null,
  requestId: null,
  resumeAt: null,
  retryAfter: null,
  errorCode: null,
  workflowCoreVersion: null,
  isWebhook: null,
  isSystem: null,
  workflowEncryptionEnabled: false,
  ...overrides,
});

describe('analyticsEventToEvent', () => {
  it('preserves wait resumeAt metadata in eventData', () => {
    const resumeAt = new Date('2026-06-30T00:05:00.000Z');
    const event = analyticsEventToEvent(
      makeAnalyticsEvent({
        resumeAt,
      })
    );

    expect(event).toMatchObject({
      runId: 'run-1',
      eventId: 'event-1',
      eventType: 'wait_created',
      correlationId: 'wait-1',
      eventData: { resumeAt },
    });
  });

  it('preserves stepName and retryAfter metadata in eventData', () => {
    const retryAfter = new Date('2026-06-30T00:10:00.000Z');
    const event = analyticsEventToEvent(
      makeAnalyticsEvent({
        eventType: 'step_retrying',
        correlationId: 'step-1',
        entityId: 'step-1',
        stepName: 'step//./src/workflows/test//doWork',
        retryAfter,
      })
    );

    expect(event).toMatchObject({
      eventType: 'step_retrying',
      correlationId: 'step-1',
      eventData: {
        stepName: 'step//./src/workflows/test//doWork',
        retryAfter,
      },
    });
  });
});

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

describe('getPublicServerConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redacts the celld shared secret while exposing connection metadata', async () => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', '@ewhauser/world-celld');
    vi.stubEnv('CELLD_FLEET_URL', 'http://fleet.internal:8080');
    vi.stubEnv('CELLD_WORLD_SECRET', 'super-secret');
    vi.stubEnv('WORKFLOW_BASE_URL', 'https://workflow.example.com');

    const config = await getPublicServerConfig();

    expect(config).toMatchObject({
      backendDisplayName: 'world-celld',
      backendId: '@ewhauser/world-celld',
      publicEnv: {
        WORKFLOW_TARGET_WORLD: '@ewhauser/world-celld',
        CELLD_FLEET_URL: 'http://fleet.internal:8080',
        WORKFLOW_BASE_URL: 'https://workflow.example.com',
      },
      sensitiveEnvKeys: ['CELLD_WORLD_SECRET'],
    });
    expect(config.publicEnv).not.toHaveProperty('CELLD_WORLD_SECRET');
  });
});
