import { getWorkflowMetadata } from 'workflow';
import { plainModuleDoneHook } from './_plain_module_hooks';

/**
 * Workflow half of the o2flow-shaped hook reproduction (see
 * `_plain_module_hooks.ts`): create a hook — defined via `defineHook()` in a
 * plain shared module — with a token derived from this run, then suspend until
 * an API route resumes it via `plainModuleDoneHook.resume(token, payload)`.
 */
export async function waitForPlainModuleHook() {
  'use workflow';

  const token = `plain-module-hook-${getWorkflowMetadata().workflowRunId}`;
  using hook = plainModuleDoneHook.create({ token });

  const payload = await hook;

  return {
    resumedWith: payload,
    plainModuleHookTestData: 'workflow_completed',
  };
}
