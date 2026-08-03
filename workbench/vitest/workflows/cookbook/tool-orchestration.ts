/**
 * Cookbook: tool-orchestration pattern
 *
 * Demonstrates the difference between step-level tools (I/O with retries)
 * and workflow-level tools (sleep, hooks) and combining both.
 */
import { sleep } from 'workflow';

// Step-level: I/O with automatic retries
async function fetchData(key: string) {
  'use step';
  return { key, value: `data-for-${key}` };
}

// Combined: workflow-level orchestration calling into steps
async function fetchWithDelay(key: string, delayMs: number) {
  // No "use step" — sleep() requires workflow context
  const result = await fetchData(key);
  await sleep(delayMs);
  return result;
}

export async function toolOrchestrationWorkflow(key: string) {
  'use workflow';

  // Step-level: direct I/O
  const direct = await fetchData(key);

  // Combined: step I/O + workflow sleep
  const delayed = await fetchWithDelay(`${key}-delayed`, 5000);

  return {
    direct: direct.value,
    delayed: delayed.value,
  };
}
