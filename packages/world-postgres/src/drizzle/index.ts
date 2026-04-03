import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as Schema from './schema.js';

export { Schema };

export type Drizzle = ReturnType<typeof createClient>;

export function createClient(pool: Pool) {
  return drizzle(pool, { schema: Schema });
}
