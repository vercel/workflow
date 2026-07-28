import { describe, expect, it } from 'vitest';
import { HookSchema } from './hooks.js';

const baseHook = {
  runId: 'wrun_1',
  hookId: 'hook_1',
  token: 'order:1',
  ownerId: 'owner_1',
  projectId: 'project_1',
  environment: 'production',
  createdAt: new Date(),
};

const resumeContext = {
  deploymentId: 'deployment_1',
  workflowName: 'processOrder',
  runSpecVersion: 5,
  workflowCoreVersion: '5.0.0',
  traceCarrier: { traceparent: '00-abc-def-01' },
  encryptionPublicKey: 'ZmFrZS1wdWJsaWMta2V5',
};

describe('HookSchema resumeContext', () => {
  it('parses and preserves a resumeContext', () => {
    const parsed = HookSchema.parse({ ...baseHook, resumeContext });
    expect(parsed.resumeContext).toEqual(resumeContext);
  });

  it('is optional — a hook without it still parses', () => {
    const parsed = HookSchema.parse(baseHook);
    expect(parsed.resumeContext).toBeUndefined();
  });

  it('an old client (schema without resumeContext) strips the unknown field, other fields intact', () => {
    // Model a pre-`resumeContext` client's schema: Zod strips unknown keys by
    // default, so the enriched response is parsed without failing and the new
    // field is simply dropped.
    const legacyHookSchema = HookSchema.omit({ resumeContext: true });
    const parsed = legacyHookSchema.parse({ ...baseHook, resumeContext });
    expect('resumeContext' in parsed).toBe(false);
    expect(parsed).toMatchObject({
      runId: baseHook.runId,
      hookId: baseHook.hookId,
      token: baseHook.token,
    });
  });
});
