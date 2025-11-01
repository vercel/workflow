import type { World } from '@workflow/world';
import { type AWSWorldConfig } from './config.js';
export type { AWSWorldConfig } from './config.js';
export declare function createWorld(config?: Partial<AWSWorldConfig>): World & {
  start(): Promise<void>;
};
