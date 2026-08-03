import { fileURLToPath } from 'node:url';

export const WORKFLOW_OPTIONAL_TYPESCRIPT_ALIAS = fileURLToPath(
  new URL('./optional-typescript.js', import.meta.url)
);
