import type { ScheduledRun, WorkflowSchedule } from 'workflow';

/**
 * Started by a Vercel Schedule, with no route of the app's in between: the
 * build reads `experimental_schedule` and emits a static schedule on this
 * workflow's schedule topic (packages/core/e2e/e2e-schedules.test.ts).
 *
 * Yearly, so it never fires during a test run; the test invokes it.
 */
export async function e2eScheduledWorkflow(run: ScheduledRun) {
  'use workflow';
  return {
    name: run.name,
    namespace: run.namespace,
    source: run.source,
    executionId: run.executionId,
    scheduleId: run.scheduleId,
    scheduledAt: run.scheduledAt.toISOString(),
    scheduledAtIsDate: run.scheduledAt instanceof Date,
    hasPayload: run.payload !== undefined,
  };
}
e2eScheduledWorkflow.experimental_schedule = {
  cron: '0 0 1 1 *',
  name: 'workflow-e2e-scheduled',
} satisfies WorkflowSchedule;
