'use server';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WorldConfig {
  backend?: string;
  env?: string;
  authToken?: string;
  project?: string;
  team?: string;
  port?: string;
  dataDir?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

// Validate configuration and return errors if any
export async function validateWorldConfig(
  config: WorldConfig
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const backend = config.backend || 'embedded';

  if (backend === 'embedded') {
    // Check if data directory exists
    if (config.dataDir) {
      const resolvedPath = resolve(config.dataDir);
      if (!existsSync(resolvedPath)) {
        errors.push({
          field: 'dataDir',
          message: `Data directory does not exist: ${resolvedPath}`,
        });
      }
    }

    // Validate port if provided
    if (config.port) {
      const portNum = Number.parseInt(config.port, 10);
      if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
        errors.push({
          field: 'port',
          message: 'Port must be a number between 1 and 65535',
        });
      }
    }
  }

  return errors;
}
