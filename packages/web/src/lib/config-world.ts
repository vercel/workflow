'use server';

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  findWorkflowDataDir,
  type WorkflowDataDirInfo,
} from '@workflow/utils/check-data-dir';
import { KNOWN_WORLDS, type KnownWorld } from './known-worlds';

export type { WorkflowDataDirInfo };

const require = createRequire(join(process.cwd(), 'index.js'));

export interface WorldConfig {
  backend?: string;
  env?: string;
  authToken?: string;
  project?: string;
  team?: string;
  port?: string;
  // Will always be defined (""./"" if not set by user), but only used for local world
  dataDir: string;
  // Path to the workflow manifest file (defaults to app/.well-known/workflow/v1/manifest.json)
  manifestPath?: string;
  // Postgres fields
  postgresUrl?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface WorldAvailability {
  id: string;
  displayName: string;
  packageName: string | null;
  description: string;
  isBuiltIn: boolean;
  isInstalled: boolean;
  installCommand?: string;
}

/**
 * Check which world packages are installed.
 *
 * Built-in worlds (local, vercel) are always available.
 * Third-party worlds are checked by attempting to resolve their package.
 */
export async function checkWorldsAvailability(): Promise<WorldAvailability[]> {
  return KNOWN_WORLDS.map((world: KnownWorld) => {
    const availability: WorldAvailability = {
      id: world.id,
      displayName: world.displayName,
      packageName: world.packageName,
      description: world.description,
      isBuiltIn: world.isBuiltIn,
      isInstalled: world.isBuiltIn, // Built-in worlds are always installed
    };

    // For non-built-in worlds, try to resolve the package
    if (!world.isBuiltIn && world.packageName) {
      try {
        require.resolve(world.packageName);
        availability.isInstalled = true;
      } catch {
        availability.isInstalled = false;
        availability.installCommand = `npm install ${world.packageName}`;
      }
    }

    return availability;
  });
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// Validate configuration and return errors/warnings
export async function validateWorldConfig(
  config: WorldConfig
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const backend = config.backend || 'local';

  if (backend === 'local') {
    // Check if data directory exists
    const resolvedPath = resolve(config.dataDir);
    if (!existsSync(resolvedPath)) {
      errors.push({
        field: 'dataDir',
        message: `Data directory does not exist: ${resolvedPath}`,
      });
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

  if (backend === 'postgres') {
    // Validate postgres connection string
    if (!config.postgresUrl) {
      errors.push({
        field: 'postgresUrl',
        message: 'PostgreSQL connection string is required',
      });
    } else if (
      !config.postgresUrl.startsWith('postgres://') &&
      !config.postgresUrl.startsWith('postgresql://')
    ) {
      errors.push({
        field: 'postgresUrl',
        message:
          'Invalid PostgreSQL connection string format (must start with postgres:// or postgresql://)',
      });
    }
  }

  return errors;
}

/**
 * Resolves a dataDir path to full WorkflowDataDirInfo.
 *
 * This function takes a dataDir path (which may be relative, absolute, or use ~)
 * and resolves it to get the projectDir and shortName for display purposes.
 *
 * @param dataDir - The data directory path to resolve
 * @returns WorkflowDataDirInfo if found, null otherwise
 */
export async function resolveDataDirInfo(
  dataDir: string
): Promise<WorkflowDataDirInfo> {
  // If no dataDir provided, try to find one from cwd
  const searchPath = dataDir;
  return findWorkflowDataDir(searchPath);
}
