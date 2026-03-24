import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; pool?: undefined }
  | { pool: Pool; connectionString?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
  jobPrefix?: string;
  queueConcurrency?: number;
};
