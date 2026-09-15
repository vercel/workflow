/**
 * Generate .d.ts stubs for esbuild-bundled workflow entry points.
 *
 * The bundled .mjs files may contain code (e.g., undici private fields)
 * that TypeScript's JS parser cannot handle. Placing .d.mts files next
 * to the .mjs files makes TypeScript use the declarations instead of
 * parsing the bundled JavaScript.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const dir = '.well-known/workflow/v1';
const stub =
  'export declare const POST: (req: Request) => Response | Promise<Response>;\n';

// Remove the declaration generated for the retired standalone step route. This
// also cleans stale build output in worktrees that were built before its removal.
rmSync(`${dir}/step.d.mts`, { force: true });

for (const name of ['flow', 'webhook']) {
  const dts = `${dir}/${name}.d.mts`;
  if (!existsSync(dts)) {
    writeFileSync(dts, stub);
  }
}
