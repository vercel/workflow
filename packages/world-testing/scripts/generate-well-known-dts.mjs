/**
 * Generate .d.ts stubs for esbuild-bundled workflow entry points.
 *
 * The bundled .js files may contain code (e.g., undici private fields)
 * that TypeScript's JS parser cannot handle. Placing .d.ts files next
 * to the .js files makes TypeScript use the declarations instead of
 * parsing the bundled JavaScript.
 */
import { existsSync, writeFileSync } from 'node:fs';

const dir = '.well-known/workflow/v1';
const stub =
  'export declare const POST: (req: Request) => Response | Promise<Response>;\n';

for (const name of ['flow', 'step', 'webhook']) {
  const dts = `${dir}/${name}.d.ts`;
  if (!existsSync(dts)) {
    writeFileSync(dts, stub);
  }
}
