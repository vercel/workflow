import { getPlatform } from 'workflow-test-dual-entry-package';

export async function blobViolationWorkflow() {
  'use workflow';
  return getPlatform();
}
