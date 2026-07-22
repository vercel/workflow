import { plainModuleDoneHook } from './_plain_module_hooks';

/**
 * Workflow half of the o2flow-shaped hook reproduction (see
 * `_plain_module_hooks.ts`): create a hook — defined via `defineHook()` in a
 * plain shared module — with a caller-provided token, then suspend until an
 * API route resumes it via `plainModuleDoneHook.resume(token, payload)`.
 */
export async function waitForPlainModuleHook(token: string) {
  'use workflow';

  using hook = plainModuleDoneHook.create({ token });

  const payload = await hook;

  return {
    resumedWith: payload,
    plainModuleHookTestData: 'workflow_completed',
  };
}
