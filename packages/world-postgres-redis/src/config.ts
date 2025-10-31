export interface PostgresWorldConfig {
  connectionString: string;
  jobPrefix?: string;
  queueConcurrency?: number;
}
