import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as Schema from './schema.js';

export { Schema };

export type Drizzle = ReturnType<typeof createClient>;

/** The handle a `Drizzle['transaction']` callback receives. */
export type DrizzleTransaction = Parameters<
  Parameters<Drizzle['transaction']>[0]
>[0];

/** The pool, or a transaction opened on it. */
export type DrizzleHandle = Drizzle | DrizzleTransaction;

export function createClient(pool: Pool) {
  return drizzle(pool, { schema: Schema });
}
