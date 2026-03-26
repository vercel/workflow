import type { Pool } from 'pg';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
  jobPrefix?: string;
  queueConcurrency?: number;
};
