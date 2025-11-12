import type { QueueDriver } from './queue-drivers/types.js';

export interface QueueConfig {
  connectionString: string;
  jobPrefix?: string;
  queueConcurrency?: number;
}

export type PostgresWorldConfig = QueueConfig & {
  queueFactory: (config: QueueConfig) => QueueDriver;
};
