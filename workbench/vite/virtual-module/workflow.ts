'use workflow';

import { getDatabaseUrl } from './db';

export async function virtualModuleWorkflow() {
  return readDatabaseUrl();
}

async function readDatabaseUrl() {
  'use step';
  return getDatabaseUrl();
}
