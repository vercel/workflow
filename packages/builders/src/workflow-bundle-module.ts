import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const WORKFLOW_BUNDLE_DIRECTORY = 'workflow-bundles';

const WORKFLOW_BUNDLE_FILE = /^[a-f0-9]{64}\.mjs$/;

export function isWorkflowBundleFileName(fileName: string): boolean {
  return WORKFLOW_BUNDLE_FILE.test(fileName);
}

export function workflowBundleFileName(code: string): string {
  const hash = createHash('sha256').update(code).digest('hex');
  return `${hash}.mjs`;
}

export function encodeWorkflowBundle(code: string): string {
  return Buffer.from(code, 'utf8').toString('base64');
}

export function serializeWorkflowBundle(code: string): string {
  // Keep inert VM source opaque to framework plugins. Nitro, for example,
  // runs textual global/template transforms over every .mjs file and can
  // otherwise rewrite JavaScript that only exists inside the exported string.
  return `export default ${JSON.stringify(encodeWorkflowBundle(code))};\n`;
}

export function deserializeWorkflowBundle(moduleCode: string): string {
  const prefix = 'export default ';
  assert(moduleCode.startsWith(prefix));
  assert(moduleCode.endsWith(';\n'));
  const encoded = JSON.parse(moduleCode.slice(prefix.length, -2)) as string;
  return Buffer.from(encoded, 'base64').toString('utf8');
}
