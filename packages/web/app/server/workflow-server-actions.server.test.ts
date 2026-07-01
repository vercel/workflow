import type { AnalyticsEvent } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { analyticsEventToEvent } from './workflow-server-actions.server';

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
