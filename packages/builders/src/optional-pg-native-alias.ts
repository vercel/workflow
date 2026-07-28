import { fileURLToPath } from 'node:url';

export const WORKFLOW_OPTIONAL_PG_NATIVE_ALIAS = fileURLToPath(
  new URL('./optional-pg-native.js', import.meta.url)
);
