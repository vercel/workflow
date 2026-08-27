'use workflow';

// `./db.js` names `./db.ts` on disk (TypeScript NodeNext style). Both halves
// of vercel/workflow#3859 are exercised here: resolving that specifier at all,
// and then resolving the Vite virtual module it imports.
import { getDatabaseUrl } from './db.js';

export async function virtualModuleWorkflow() {
  return await readDatabaseUrl();
}

async function readDatabaseUrl() {
  'use step';
  return getDatabaseUrl();
}
