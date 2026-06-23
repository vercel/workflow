/**
 * Workflows that import a plain local TypeScript helper and use it in
 * the workflow body and in a step body. Regression test for
 * vercel/workflow#2289: these helpers must be bundled into the step
 * bundle rather than externalized, because the generated bundle is
 * loaded directly by Node's ESM loader in the vitest worker.
 */
// Extensionless on purpose: it resolves to the `.ts` source, which is
// the externalization shape reported in the issue (a `./helper.js`
// import fails enhanced-resolve and falls back to inline bundling).
import { buildPayload } from './local-helper';

export async function echoPayload(p: { label: string; kind: string }) {
  'use step';
  // Use the helper inside a step body too, so the import survives in
  // the step bundle even when workflow bodies are stubbed out.
  const rebuilt = buildPayload(p.label);
  return `${rebuilt.label}:${rebuilt.kind}`;
}

export async function localHelperWorkflow(label: string) {
  'use workflow';
  // Use the helper inside the workflow body (the shape reported in
  // the issue).
  const payload = buildPayload(label);
  return await echoPayload(payload);
}
