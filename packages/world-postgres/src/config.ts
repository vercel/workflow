import type { QueueDriver } from './queue-drivers/types.js';

export type PostgresWorldConfig = {
  securityToken: string;
  connectionString: string;
  queueFactory: () => QueueDriver;
};
