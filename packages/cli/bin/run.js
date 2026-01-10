#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execute } from '@oclif/core';
import { config } from 'dotenv';

// Load .env file if it exists
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  config({ path: envPath });
}

// Load .env.local file if it exists (overrides .env)
const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  config({ path: envLocalPath, override: true });
}

await execute({ type: 'esm', development: false, dir: import.meta.url });
