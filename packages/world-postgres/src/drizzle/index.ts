import { drizzle } from 'drizzle-orm/postgres-js';
import type Postgres from 'postgres';
import * as Schema from './schema.js';

export { Schema };

export type Drizzle = ReturnType<typeof createClient>;

export function createClient(postgres: Postgres.Sql) {
  return drizzle(postgres, { schema: Schema });
}
