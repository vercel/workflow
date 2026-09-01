/**
 * Generate .d.ts stubs for esbuild-bundled workflow entry points.
 *
 * The bundled .mjs files may contain code (e.g., undici private fields)
 * that TypeScript's JS parser cannot handle. Placing .d.mts files next
 * to the .mjs files makes TypeScript use the declarations instead of
 * parsing the bundled JavaScript.
 */
import { rmSync, writeFileSync } from 'node:fs';

const dir = '.well-known/workflow/v1';
const handler =
  'export declare const POST: (req: Request) => Response | Promise<Response>;\n';
const stubs = {
  flow: `import type { WorkflowEntrypoint } from 'workflow/runtime';
export declare const POST: WorkflowEntrypoint;
`,
  webhook: handler,
};

// Remove the declaration generated for the retired standalone step route. This
// also cleans stale build output in worktrees that were built before its removal.
rmSync(`${dir}/step.d.mts`, { force: true });

for (const name of ['flow', 'webhook']) {
  writeFileSync(`${dir}/${name}.d.mts`, stubs[name]);
}
