import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractWorkflowGraphs } from './workflows-extractor.js';

async function createWorkflowBundleFile(
  workflowCode: string
): Promise<{ filePath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'workflow-extractor-'));
  const filePath = join(tempDir, 'route.js');
  const escapedWorkflowCode = workflowCode.replace(/[\\`$]/g, '\\$&');
  const bundleCode = `const workflowCode = \`${escapedWorkflowCode}\`;
export const POST = workflowCode;`;
  await writeFile(filePath, bundleCode, 'utf8');
  return { filePath, tempDir };
}

describe('workflows-extractor', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  it('detects step declarations that include @__PURE__ annotations', async () => {
    const workflowCode = `
var stepWithPure = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/demo//stepWithPure");
async function demo() {
  const value = await stepWithPure();
  return value;
}
demo.workflowId = "workflow//./workflows/demo//demo";
globalThis.__private_workflows.set("workflow//./workflows/demo//demo", demo);
`;
    const { filePath, tempDir } = await createWorkflowBundleFile(workflowCode);
    tempDirs.push(tempDir);

    const graphs = await extractWorkflowGraphs(filePath);
    const demoGraph = graphs['./workflows/demo']?.demo?.graph;
    const labels = (demoGraph?.nodes || []).map((node) => node.data.label);

    expect(labels).toContain('stepWithPure');
  });

  it('detects createHook wrapped by transpiled using helpers inside try/finally', async () => {
    const workflowCode = `
var stepA = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/hooks//stepA");
function _ts_add_disposable_resource(_env, value, _isAsync) {
  return value;
}
function _ts_dispose_resources(_env) {}
async function withHook() {
  const env = { stack: [] };
  try {
    const responseId = await stepA();
    const hook = _ts_add_disposable_resource(env, createHook({ token: 'hook:' + responseId }), false);
    const payload = await hook;
    return payload;
  } finally {
    _ts_dispose_resources(env);
  }
}
withHook.workflowId = "workflow//./workflows/hooks//withHook";
globalThis.__private_workflows.set("workflow//./workflows/hooks//withHook", withHook);
`;
    const { filePath, tempDir } = await createWorkflowBundleFile(workflowCode);
    tempDirs.push(tempDir);

    const graphs = await extractWorkflowGraphs(filePath);
    const hookGraph = graphs['./workflows/hooks']?.withHook?.graph;
    const labels = (hookGraph?.nodes || []).map((node) => node.data.label);

    expect(labels).toEqual(
      expect.arrayContaining(['stepA', 'createHook', 'awaitWebhook'])
    );
  });
});
