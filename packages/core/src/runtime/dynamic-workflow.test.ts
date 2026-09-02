import { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  compileDynamicWorkflow,
  DYNAMIC_WORKFLOW_SOURCE_MAX_BYTES,
  readDynamicWorkflowMetadata,
} from './dynamic-workflow.js';

const SOURCE = `
async function workflow(input) {
  "use workflow";
  const user = await steps.fetchUser(input.userId);
  await steps.sendEmail(user.email);
  return { ok: true };
}
`;

const STEPS = {
  fetchUser: { stepId: 'step//./src/steps//fetchUser' },
  sendEmail: { stepId: 'step//./src/steps//sendEmail' },
};

describe('compileDynamicWorkflow', () => {
  describe('generated code', () => {
    it('registers the function under the generated workflow id', async () => {
      const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      expect(compiled.workflowName).toMatch(
        /^workflow\/\/dynamic\/[0-9a-f]{32}\/\/workflow$/
      );
      expect(compiled.workflowCode).toContain(
        `globalThis.__private_workflows.set(${JSON.stringify(compiled.workflowName)}, workflow)`
      );
      // The id has to be on the function too — the runtime reads it back off
      // the registered function, same as a build-time transform stamps it.
      expect(compiled.workflowCode).toContain(
        `Object.defineProperty(workflow, "workflowId"`
      );
      expect(compiled.workflowCode).toContain(SOURCE.trim());
    });

    it('binds only the aliases it was given, through WORKFLOW_USE_STEP', async () => {
      const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      expect(compiled.workflowCode).toContain(
        '"fetchUser": __dynamicUseStep("step//./src/steps//fetchUser")'
      );
      expect(compiled.workflowCode).toContain(
        '"sendEmail": __dynamicUseStep("step//./src/steps//sendEmail")'
      );
      // Frozen so ordinary generated code that reaches for a step it was not
      // given fails the run rather than silently adding one.
      expect(compiled.workflowCode).toContain('Object.freeze({');
      expect(compiled.workflowCode).not.toContain('notAllowed');
    });

    it('exposes sleep and createHook from the VM globals', async () => {
      const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      expect(compiled.workflowCode).toContain(
        'const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")]'
      );
      expect(compiled.workflowCode).toContain(
        'const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]'
      );
    });

    it('honours a custom exportName', async () => {
      const source = `async function orchestrate() { "use workflow"; await steps.fetchUser(); }`;

      const compiled = await compileDynamicWorkflow(source, {
        steps: STEPS,
        exportName: 'orchestrate',
      });

      expect(compiled.workflowName).toMatch(/\/\/orchestrate$/);
      expect(compiled.metadata.exportName).toBe('orchestrate');
      expect(compiled.workflowCode).toContain(
        'globalThis.__private_workflows.set('
      );
    });
  });

  describe('workflow id derivation', () => {
    it('is stable across calls', async () => {
      const a = await compileDynamicWorkflow(SOURCE, { steps: STEPS });
      const b = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      expect(a.workflowName).toBe(b.workflowName);
      expect(a.metadata.sourceHash).toBe(b.metadata.sourceHash);
    });

    it('does not depend on the order the steps were declared in', async () => {
      // Otherwise the same workflow would land on two different queue topics
      // depending on how the caller happened to build the object.
      const a = await compileDynamicWorkflow(SOURCE, { steps: STEPS });
      const b = await compileDynamicWorkflow(SOURCE, {
        steps: {
          sendEmail: STEPS.sendEmail,
          fetchUser: STEPS.fetchUser,
        },
      });

      expect(a.workflowName).toBe(b.workflowName);
    });

    it('changes when the source changes', async () => {
      const a = await compileDynamicWorkflow(SOURCE, { steps: STEPS });
      const b = await compileDynamicWorkflow(
        SOURCE.replace('{ ok: true }', '{ ok: false }'),
        { steps: STEPS }
      );

      expect(a.workflowName).not.toBe(b.workflowName);
    });

    it('changes when a step binding changes', async () => {
      // The bindings are as much part of what executes as the source is: the
      // same text over different steps is a different workflow.
      const a = await compileDynamicWorkflow(SOURCE, { steps: STEPS });
      const b = await compileDynamicWorkflow(SOURCE, {
        steps: {
          ...STEPS,
          sendEmail: { stepId: 'step//./src/steps//sendSms' },
        },
      });

      expect(a.workflowName).not.toBe(b.workflowName);
    });
  });

  describe('metadata', () => {
    it('records the version, hash, export name and step bindings', async () => {
      const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      expect(compiled.metadata).toEqual({
        version: 1,
        sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        exportName: 'workflow',
        steps: {
          fetchUser: 'step//./src/steps//fetchUser',
          sendEmail: 'step//./src/steps//sendEmail',
        },
      });
    });

    it('carries no source or code, so it stays inside the plaintext budget', async () => {
      // The metadata is readable without decrypting anything, so the code
      // must not be in it — that is the whole point of storing the code
      // encrypted behind a ref.
      const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

      const encoded = JSON.stringify(compiled.metadata);
      expect(encoded).not.toContain('use workflow');
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(1024);
    });
  });

  describe('validation', () => {
    it('rejects source with no matching async function', async () => {
      await expect(
        compileDynamicWorkflow('const x = 1;', { steps: STEPS })
      ).rejects.toThrow(/must declare `async function workflow/);
    });

    it('rejects a non-async function', async () => {
      await expect(
        compileDynamicWorkflow('function workflow() { "use workflow"; }', {
          steps: STEPS,
        })
      ).rejects.toThrow(/must declare `async function workflow/);
    });

    it('rejects a missing "use workflow" directive', async () => {
      await expect(
        compileDynamicWorkflow(
          'async function workflow() { await steps.fetchUser(); }',
          { steps: STEPS }
        )
      ).rejects.toThrow(/"use workflow" directive/);
    });

    it.each([
      ['named import', 'import { x } from "y";\n'],
      ['namespace import', 'import * as y from "y";\n'],
      ['bare import', 'import "y";\n'],
      ['indented import', '  import { x } from "y";\n'],
      ['export function', 'export function helper() {}\n'],
      ['export const', 'export const helper = 1;\n'],
      ['export default', 'export default 1;\n'],
      ['export list', 'export { workflow };\n'],
    ])('rejects module syntax: %s', async (_label, prefix) => {
      // The code is evaluated as a script in the workflow VM, so module
      // syntax is a replay-time syntax error — catching it here turns a run
      // that could never execute into a failed call.
      await expect(
        compileDynamicWorkflow(prefix + SOURCE, { steps: STEPS })
      ).rejects.toThrow(/cannot use `import` or `export`/);
    });

    it('accepts source that merely mentions import inside a string', async () => {
      // The check is anchored to the start of a line for exactly this: a
      // false positive costs the caller a working workflow, and prose inside
      // string arguments is normal in generated orchestration.
      const source = `
async function workflow() {
  "use workflow";
  await steps.fetchUser("nothing to import here");
}
`;
      await expect(
        compileDynamicWorkflow(source, { steps: STEPS })
      ).resolves.toMatchObject({ metadata: { version: 1 } });
    });

    it('rejects source over the size limit', async () => {
      const filler = `\n// ${'x'.repeat(DYNAMIC_WORKFLOW_SOURCE_MAX_BYTES)}`;

      await expect(
        compileDynamicWorkflow(SOURCE + filler, { steps: STEPS })
      ).rejects.toThrow(/over the \d+-byte limit/);
    });

    it('rejects an empty step map', async () => {
      await expect(
        compileDynamicWorkflow(SOURCE, { steps: {} })
      ).rejects.toThrow(/at least one registered step/);
    });

    it('rejects a step value with no stepId', async () => {
      await expect(
        compileDynamicWorkflow(SOURCE, {
          steps: { fetchUser: {} as { stepId: string } },
        })
      ).rejects.toThrow(/imported step function or an object with/);
    });

    it.each([
      ['a step alias', { steps: { 'not-an-identifier': STEPS.fetchUser } }],
      ['an export name', { steps: STEPS, exportName: 'not-an-identifier' }],
    ])('rejects %s that is not a JavaScript identifier', async (_label, options) => {
      // These are interpolated into generated code, so anything that is not
      // an identifier would produce a syntax error at replay time at best.
      await expect(
        compileDynamicWorkflow(SOURCE, options as never)
      ).rejects.toThrow(WorkflowRuntimeError);
    });
  });
});

describe('readDynamicWorkflowMetadata', () => {
  it('reads back what compile produced', async () => {
    const compiled = await compileDynamicWorkflow(SOURCE, { steps: STEPS });

    expect(
      readDynamicWorkflowMetadata({ dynamicWorkflow: compiled.metadata })
    ).toEqual(compiled.metadata);
  });

  it.each([
    ['undefined context', undefined],
    ['no marker', { workflowCoreVersion: '5.0.0' }],
    ['a non-object marker', { dynamicWorkflow: 'yes' }],
    ['an unknown version', { dynamicWorkflow: { version: 2 } }],
    [
      'a missing exportName',
      { dynamicWorkflow: { version: 1, sourceHash: 'a' } },
    ],
    [
      'a missing sourceHash',
      { dynamicWorkflow: { version: 1, exportName: 'workflow' } },
    ],
  ])('returns undefined for %s', (_label, executionContext) => {
    // executionContext is client-supplied and passes through the backend
    // unchecked, so the runtime validates the shape rather than trusting it:
    // the alternative to "not dynamic" is executing arbitrary stored bytes as
    // code.
    expect(readDynamicWorkflowMetadata(executionContext)).toBeUndefined();
  });

  it('defaults absent step bindings to an empty map', () => {
    expect(
      readDynamicWorkflowMetadata({
        dynamicWorkflow: { version: 1, sourceHash: 'abc', exportName: 'wf' },
      })
    ).toEqual({
      version: 1,
      sourceHash: 'abc',
      exportName: 'wf',
      steps: {},
    });
  });
});
