'use server';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorld } from '@workflow/core/runtime';
import type { SearchParams } from 'next/dist/server/request/search-params';

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

export const getDefaultWorldConfig = async (
  params: SearchParams
): Promise<WorldConfig> => {
  const config: WorldConfig = {
    backend: 'embedded',
    dataDir: '../../workbench/nextjs-turbopack/.next/workflow-data',
    port: '3000',
    env: 'production',
  };

  // Convert search params to config object
  for (const [key, value] of Object.entries(params)) {
    if (value && !Array.isArray(value)) {
      config[key as keyof WorldConfig] = value;
    }
  }

  return config;
};

// Set up environment variables from config
export async function setupWorld(config: WorldConfig) {
  // Validate first
  const errors = await validateWorldConfig(config);
  if (errors.length > 0) {
    // TODO: Catch this error downstream and show the issue to the user
    throw new Error(
      `Configuration validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join(', ')}`
    );
  }

  const backend = config.backend || 'embedded';

  // Set env vars
  process.env.WORKFLOW_TARGET_WORLD = backend;

  if (backend === 'embedded') {
    // Use provided config or fall back to default for localhost dev setup
    if (config.dataDir) {
      process.env.WORKFLOW_EMBEDDED_DATA_DIR = config.dataDir;
    }

    if (config.port) {
      process.env.PORT = config.port;
    }
  } else if (backend === 'vercel') {
    if (config.env) {
      process.env.WORKFLOW_VERCEL_ENV = config.env;
    }
    if (config.authToken) {
      process.env.WORKFLOW_VERCEL_AUTH_TOKEN = config.authToken;
    }
    if (config.project) {
      process.env.WORKFLOW_VERCEL_PROJECT = config.project;
    }
    if (config.team) {
      process.env.WORKFLOW_VERCEL_TEAM = config.team;
    }
  }

  return createWorld();
}
