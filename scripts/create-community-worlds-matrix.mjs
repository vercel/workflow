#!/usr/bin/env node

/**
 * Generates a GitHub Actions matrix for community world testing.
 * Reads from worlds-manifest.json and filters to testable community worlds.
 *
 * Usage: node scripts/create-community-worlds-matrix.mjs
 *
 * Output format (JSON):
 * {
 *   "world": [
 *     {
 *       "id": "starter",
 *       "name": "Starter",
 *       "package": "@workflow-worlds/starter",
 *       "service-type": "none",
 *       "env-vars": "{\"WORKFLOW_TARGET_WORLD\":\"@workflow-worlds/starter\"}"
 *     },
 *     ...
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read the manifest
const manifestPath = path.join(rootDir, 'worlds-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// Filter to community worlds that can be tested in CI
const testableWorlds = manifest.worlds.filter((world) => {
  // Only community worlds
  if (world.type !== 'community') return false;

  // Skip worlds that require external credentials (e.g., Jazz needs API keys)
  if (world.requiresCredentials) return false;

  return true;
});

// Build the matrix
const matrix = {
  world: testableWorlds.map((world) => {
    // Determine service type based on services array
    let serviceType = 'none';
    if (world.services && world.services.length > 0) {
      // Use the first service's name as the service type
      // Currently supports: mongodb, redis
      const serviceName = world.services[0].name;
      if (['mongodb', 'redis'].includes(serviceName)) {
        serviceType = serviceName;
      }
    }

    return {
      id: world.id,
      name: world.name,
      package: world.package,
      'service-type': serviceType,
      'env-vars': JSON.stringify(world.env || {}),
    };
  }),
};

// Output JSON for GitHub Actions
console.log(JSON.stringify(matrix));
