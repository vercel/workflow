'use workflow';

import { env } from 'virtual:env/server';
// `./db.js` names `./db.ts` on disk (TypeScript NodeNext style). Both halves
// of vercel/workflow#3859 are exercised here: resolving that specifier at all,
// and then resolving the Vite virtual module it imports.
import { getDatabaseUrl } from './db.js';

export async function virtualModuleWorkflow() {
  const [databaseUrl, directDatabaseUrl] = await Promise.all([
    readDatabaseUrl(),
    readDirectDatabaseUrl(),
  ]);
  if (!databaseUrl.startsWith(directDatabaseUrl)) {
    throw new Error('Direct and transitive virtual modules disagree');
  }
  return databaseUrl;
}

async function readDatabaseUrl() {
  'use step';
  return getDatabaseUrl();
}

async function readDirectDatabaseUrl() {
  'use step';
  return env.DATABASE_URL;
}
