/**
 * Workflow that uses a third-party npm package (ms) in a step.
 * Used to test whether vi.mock() works for third-party dependencies.
 */
import ms from 'ms';
import { formatDurationUtil } from './utils';

export async function formatDurationStepUsingExternal(duration: string) {
  'use step';
  return formatDurationUtil(duration);
}

export async function formatDurationStep(duration: string) {
  'use step';
  return ms(duration);
}

export async function durationWorkflow(duration: string) {
  'use workflow';
  const result = await formatDurationStep(duration);
  return { ms: result };
}

export async function durationWorkflowInline(duration: string) {
  'use workflow';
  return { ms: ms(duration) };
}

export async function durationWorkflowStepUtil(duration: string) {
  'use workflow';
  return { ms: await formatDurationStepUsingExternal(duration) };
}
