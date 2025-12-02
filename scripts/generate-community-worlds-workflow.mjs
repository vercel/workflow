#!/usr/bin/env node

/**
 * Generates .github/workflows/community-worlds.yml from community-worlds.json
 *
 * Usage: node scripts/generate-community-worlds-workflow.mjs
 *
 * This script reads the community-worlds.json manifest and generates a GitHub
 * Actions workflow that runs E2E tests against each community world.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read the manifest
const manifestPath = path.join(rootDir, 'community-worlds.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// YAML helper - properly escape strings
function yamlString(str) {
  if (
    str.includes(':') ||
    str.includes('#') ||
    str.includes("'") ||
    str.includes('"') ||
    str.includes('\n') ||
    str.startsWith(' ') ||
    str.endsWith(' ') ||
    str.startsWith('@') ||
    str.startsWith('*') ||
    str.startsWith('&') ||
    str.startsWith('!')
  ) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

// Generate a single job for a world
function generateJob(world, isE2E = true, isBenchmark = false) {
  const jobId = isBenchmark ? `benchmark-${world.id}` : `e2e-${world.id}`;
  const jobName = isBenchmark
    ? `Benchmark ${world.name} World`
    : `E2E ${world.name} World Tests`;

  const lines = [];
  lines.push(`  ${jobId}:`);
  lines.push(`    name: ${jobName}`);
  lines.push(`    runs-on: ubuntu-latest`);

  if (isE2E) {
    lines.push(`    continue-on-error: true`);
  }

  if (isBenchmark) {
    lines.push(`    needs: build`);
    lines.push(`    timeout-minutes: 30`);
  }

  // Services
  if (world.services && world.services.length > 0) {
    lines.push(`    services:`);
    for (const service of world.services) {
      lines.push(`      ${service.name}:`);
      lines.push(`        image: ${service.image}`);
      if (service.ports && service.ports.length > 0) {
        lines.push(`        ports:`);
        for (const port of service.ports) {
          lines.push(`          - ${port}`);
        }
      }
      if (service.healthCheck) {
        // Health cmd with spaces needs special quoting for Docker
        const healthCmd = service.healthCheck.cmd.includes(' ')
          ? `"${service.healthCheck.cmd}"`
          : service.healthCheck.cmd;
        lines.push(`        options: >-`);
        lines.push(`          --health-cmd ${healthCmd}`);
        lines.push(
          `          --health-interval ${service.healthCheck.interval}`
        );
        lines.push(`          --health-timeout ${service.healthCheck.timeout}`);
        lines.push(`          --health-retries ${service.healthCheck.retries}`);
      }
    }
  }

  // Environment variables
  lines.push(`    env:`);
  lines.push(`      TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}`);
  lines.push(`      TURBO_TEAM: \${{ vars.TURBO_TEAM }}`);
  for (const [key, value] of Object.entries(world.env)) {
    lines.push(`      ${key}: ${yamlString(value)}`);
  }

  // Steps
  lines.push(`    steps:`);
  lines.push(`      - name: Checkout Repo`);
  lines.push(`        uses: actions/checkout@v4`);
  lines.push(``);
  lines.push(`      - name: Setup pnpm`);
  lines.push(`        uses: pnpm/action-setup@v3`);
  lines.push(`        with:`);
  lines.push(`          version: 10.14.0`);
  lines.push(``);
  lines.push(`      - name: Setup Node.js 22.x`);
  lines.push(`        uses: actions/setup-node@v4`);
  lines.push(`        with:`);
  lines.push(`          node-version: 22.x`);
  lines.push(`          cache: "pnpm"`);
  lines.push(``);

  if (isBenchmark) {
    lines.push(`      - name: Download build artifacts`);
    lines.push(`        uses: actions/download-artifact@v4`);
    lines.push(`        with:`);
    lines.push(`          name: build-artifacts`);
    lines.push(`          path: .`);
    lines.push(``);
  }

  lines.push(`      - name: Install Dependencies`);
  lines.push(`        run: pnpm install --frozen-lockfile`);
  lines.push(``);
  lines.push(`      - name: Install ${world.name} World`);
  lines.push(
    `        run: pnpm --filter nextjs-turbopack add ${world.package}`
  );
  lines.push(``);

  if (!isBenchmark) {
    lines.push(`      - name: Run Initial Build`);
    lines.push(`        run: pnpm turbo run build --filter='!./workbench/*'`);
    lines.push(``);
  }

  lines.push(`      - name: Resolve symlinks`);
  lines.push(
    `        run: ./scripts/resolve-symlinks.sh workbench/nextjs-turbopack`
  );
  lines.push(``);

  if (isBenchmark) {
    lines.push(`      - name: Build workbench`);
    lines.push(
      `        run: pnpm turbo run build --filter='./workbench/nextjs-turbopack'`
    );
    lines.push(``);
    lines.push(`      - name: Run benchmarks`);
    lines.push(`        env:`);
    lines.push(`          DEPLOYMENT_URL: "http://localhost:3000"`);
    lines.push(`          APP_NAME: "nextjs-turbopack"`);
    lines.push(`        run: |`);
    lines.push(`          cd workbench/nextjs-turbopack`);
    lines.push(`          pnpm start &`);
    lines.push(`          echo "Waiting for server to start..."`);
    lines.push(`          sleep 15`);
    lines.push(`          cd ../..`);
    lines.push(
      `          pnpm vitest bench packages/core/e2e/bench.bench.ts --run --outputJson=bench-results-nextjs-turbopack-${world.id}.json`
    );
    lines.push(``);
    lines.push(`      - name: Render benchmark results`);
    lines.push(`        uses: ./.github/actions/render-benchmarks`);
    lines.push(`        with:`);
    lines.push(
      `          benchmark-file: bench-results-nextjs-turbopack-${world.id}.json`
    );
    lines.push(`          app-name: nextjs-turbopack`);
    lines.push(`          backend: ${world.id}`);
    lines.push(``);
    lines.push(`      - name: Upload benchmark results`);
    lines.push(`        uses: actions/upload-artifact@v4`);
    lines.push(`        with:`);
    lines.push(`          name: bench-results-nextjs-turbopack-${world.id}`);
    lines.push(`          path: |`);
    lines.push(`            bench-results-nextjs-turbopack-${world.id}.json`);
    lines.push(`            bench-timings-nextjs-turbopack-${world.id}.json`);
  } else {
    // E2E test step
    const devTestConfig = JSON.stringify({
      name: 'nextjs-turbopack',
      project: 'workbench-nextjs-turbopack-workflow',
      generatedStepPath: 'app/.well-known/workflow/v1/step/route.js',
      generatedWorkflowPath: 'app/.well-known/workflow/v1/flow/route.js',
      apiFilePath: 'app/api/chat/route.ts',
      apiFileImportPath: '../../..',
    });

    lines.push(`      - name: Run E2E Tests`);
    lines.push(
      `        run: cd workbench/nextjs-turbopack && pnpm dev & echo "starting tests in 15 seconds" && sleep 15 && pnpm vitest run packages/core/e2e/dev.test.ts && sleep 10 && pnpm run test:e2e`
    );
    lines.push(`        env:`);
    lines.push(`          APP_NAME: "nextjs-turbopack"`);
    lines.push(`          DEPLOYMENT_URL: "http://localhost:3000"`);
    lines.push(`          DEV_TEST_CONFIG: '${devTestConfig}'`);
  }

  return lines.join('\n');
}

// Generate E2E workflow
function generateE2EWorkflow() {
  const lines = [];

  // Header comment
  lines.push(`# AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY`);
  lines.push(`# This file is generated from community-worlds.json`);
  lines.push(`# Run: node scripts/generate-community-worlds-workflow.mjs`);
  lines.push(``);
  lines.push(`name: Community Worlds E2E Tests`);
  lines.push(``);
  lines.push(`on:`);
  lines.push(`  push:`);
  lines.push(`    branches:`);
  lines.push(`      - main`);
  lines.push(`    tags:`);
  lines.push(`      - "!*"`);
  lines.push(`  pull_request:`);
  lines.push(`  workflow_dispatch:`);
  lines.push(``);
  lines.push(`concurrency:`);
  lines.push(`  group: \${{ github.workflow }}-\${{ github.ref }}`);
  lines.push(`  cancel-in-progress: true`);
  lines.push(``);
  lines.push(`jobs:`);

  // Generate a job for each world
  for (const world of manifest.worlds) {
    lines.push(generateJob(world, true, false));
    lines.push(``);
  }

  return lines.join('\n');
}

// Write the workflow file
const workflowPath = path.join(
  rootDir,
  '.github/workflows/community-worlds.yml'
);
const workflowContent = generateE2EWorkflow();
fs.writeFileSync(workflowPath, workflowContent);

console.log(`Generated ${workflowPath}`);
console.log(`  - ${manifest.worlds.length} world(s) configured`);
for (const world of manifest.worlds) {
  console.log(`    - ${world.name} (${world.package})`);
}
