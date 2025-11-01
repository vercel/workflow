export interface PostgresRedisWorldConfig {
  connectionString: string;
  redisUrl: string;
  jobPrefix?: string;
  queueConcurrency?: number;
}
