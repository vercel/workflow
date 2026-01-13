#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execute } from '@oclif/core';
import { config } from 'dotenv';

// Load .env file if it exists
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const envResult = config({ path: envPath });
  if (envResult.error && envResult.error.code !== 'ENOENT') {
    console.warn(`Warning: Failed to load .env file: ${envResult.error.message}`);
  }
}

// Load .env.local file if it exists (overrides .env)
const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  const envLocalResult = config({ path: envLocalPath, override: true });
  if (envLocalResult.error && envLocalResult.error.code !== 'ENOENT') {
    console.warn(`Warning: Failed to load .env.local file: ${envLocalResult.error.message}`);
  }
}

await execute({ type: 'esm', development: false, dir: import.meta.url });
