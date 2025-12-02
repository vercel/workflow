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
  lines.push(`    needs: build`);

  if (isE2E) {
    lines.push(`    continue-on-error: true`);
  }

  if (isBenchmark) {
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

  // Download build artifacts (shared by both E2E and benchmark jobs)
  lines.push(`      - name: Download build artifacts`);
  lines.push(`        uses: actions/download-artifact@v4`);
  lines.push(`        with:`);
  lines.push(`          name: build-artifacts`);
  lines.push(`          path: .`);
  lines.push(``);

  lines.push(`      - name: Install Dependencies`);
  lines.push(`        run: pnpm install --frozen-lockfile`);
  lines.push(``);
  lines.push(`      - name: Install ${world.name} World`);
  lines.push(
    `        run: pnpm --filter nextjs-turbopack add ${world.package}`
  );
  lines.push(``);

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
    lines.push(`        id: e2e-tests`);
    lines.push(`        run: |`);
    lines.push(`          cd workbench/nextjs-turbopack && pnpm dev &`);
    lines.push(`          echo "starting tests in 15 seconds" && sleep 15`);
    lines.push(
      `          pnpm vitest run packages/core/e2e/dev.test.ts --reporter=json --outputFile=e2e-dev-results-${world.id}.json || true`
    );
    lines.push(`          sleep 10`);
    lines.push(
      `          pnpm vitest run packages/core/e2e/e2e.test.ts --reporter=json --outputFile=e2e-results-${world.id}.json || true`
    );
    lines.push(`        env:`);
    lines.push(`          APP_NAME: "nextjs-turbopack"`);
    lines.push(`          DEPLOYMENT_URL: "http://localhost:3000"`);
    lines.push(`          DEV_TEST_CONFIG: '${devTestConfig}'`);
    lines.push(``);
    lines.push(`      - name: Upload E2E results`);
    lines.push(`        uses: actions/upload-artifact@v4`);
    lines.push(`        if: always()`);
    lines.push(`        with:`);
    lines.push(`          name: e2e-results-${world.id}`);
    lines.push(`          path: |`);
    lines.push(`            e2e-dev-results-${world.id}.json`);
    lines.push(`            e2e-results-${world.id}.json`);
  }

  return lines.join('\n');
}

// Generate build job (shared by E2E and benchmark jobs)
function generateBuildJob() {
  const lines = [];
  lines.push(`  build:`);
  lines.push(`    name: Build Packages`);
  lines.push(`    runs-on: ubuntu-latest`);
  lines.push(`    timeout-minutes: 30`);
  lines.push(`    env:`);
  lines.push(`      TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}`);
  lines.push(`      TURBO_TEAM: \${{ vars.TURBO_TEAM }}`);
  lines.push(``);
  lines.push(`    steps:`);
  lines.push(`      - uses: actions/checkout@v4`);
  lines.push(``);
  lines.push(`      - uses: pnpm/action-setup@v3`);
  lines.push(`        with:`);
  lines.push(`          version: 10.14.0`);
  lines.push(``);
  lines.push(`      - uses: actions/setup-node@v4`);
  lines.push(`        with:`);
  lines.push(`          node-version: 22.x`);
  lines.push(`          cache: 'pnpm'`);
  lines.push(``);
  lines.push(`      - name: Install dependencies`);
  lines.push(`        run: pnpm install --frozen-lockfile`);
  lines.push(``);
  lines.push(`      - name: Build all packages`);
  lines.push(`        run: pnpm turbo run build --filter='!./workbench/*'`);
  lines.push(``);
  lines.push(`      - name: Upload build artifacts`);
  lines.push(`        uses: actions/upload-artifact@v4`);
  lines.push(`        with:`);
  lines.push(`          name: build-artifacts`);
  lines.push(`          path: |`);
  lines.push(`            node_modules`);
  lines.push(`            packages/*/dist`);
  lines.push(`          retention-days: 1`);

  return lines.join('\n');
}

// Generate summary job that collects test results
function generateSummaryJob(includeBenchmarks = false) {
  const worldIds = manifest.worlds.map((w) => w.id);
  const e2eNeeds = worldIds.map((id) => `e2e-${id}`);
  const benchmarkNeeds = includeBenchmarks
    ? worldIds.map((id) => `benchmark-${id}`)
    : [];
  const needsList = [...e2eNeeds, ...benchmarkNeeds].join(', ');

  const lines = [];
  lines.push(`  summary:`);
  lines.push(`    name: Test Results Summary`);
  lines.push(`    runs-on: ubuntu-latest`);
  lines.push(`    needs: [${needsList}]`);
  lines.push(`    if: always()`);
  lines.push(`    steps:`);

  // Download all E2E result artifacts
  lines.push(`      - name: Download all E2E results`);
  lines.push(`        uses: actions/download-artifact@v4`);
  lines.push(`        with:`);
  lines.push(`          pattern: e2e-results-*`);
  lines.push(`          path: e2e-results`);
  lines.push(`          merge-multiple: false`);
  lines.push(``);

  if (includeBenchmarks) {
    lines.push(`      - name: Download all benchmark results`);
    lines.push(`        uses: actions/download-artifact@v4`);
    lines.push(`        with:`);
    lines.push(`          pattern: bench-results-*`);
    lines.push(`          path: bench-results`);
    lines.push(`          merge-multiple: false`);
    lines.push(``);
  }

  lines.push(`      - name: Generate Summary`);
  lines.push(`        uses: actions/github-script@v7`);
  lines.push(`        with:`);
  lines.push(`          script: |`);
  lines.push(`            const fs = require('fs');`);
  lines.push(`            const path = require('path');`);
  lines.push(`            `);
  lines.push(
    `            const worlds = ${JSON.stringify(manifest.worlds.map((w) => ({ id: w.id, name: w.name, package: w.package })))};`
  );
  lines.push(`            `);
  lines.push(`            // Parse vitest JSON results`);
  lines.push(`            function parseVitestResults(filePath) {`);
  lines.push(`              try {`);
  lines.push(`                if (!fs.existsSync(filePath)) return null;`);
  lines.push(
    `                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));`
  );
  lines.push(`                return {`);
  lines.push(`                  passed: data.numPassedTests || 0,`);
  lines.push(`                  failed: data.numFailedTests || 0,`);
  lines.push(`                  skipped: data.numPendingTests || 0,`);
  lines.push(
    `                  total: (data.numPassedTests || 0) + (data.numFailedTests || 0) + (data.numPendingTests || 0),`
  );
  lines.push(`                  success: data.success`);
  lines.push(`                };`);
  lines.push(`              } catch (e) {`);
  lines.push(
    `                console.log(\`Failed to parse \${filePath}: \${e}\`);`
  );
  lines.push(`                return null;`);
  lines.push(`              }`);
  lines.push(`            }`);
  lines.push(`            `);
  lines.push(`            // Collect results for each world`);
  lines.push(`            const results = {};`);
  lines.push(`            for (const world of worlds) {`);
  lines.push(
    `              const devResultsPath = path.join('e2e-results', \`e2e-results-\${world.id}\`, \`e2e-dev-results-\${world.id}.json\`);`
  );
  lines.push(
    `              const e2eResultsPath = path.join('e2e-results', \`e2e-results-\${world.id}\`, \`e2e-results-\${world.id}.json\`);`
  );
  lines.push(`              `);
  lines.push(
    `              const devResults = parseVitestResults(devResultsPath);`
  );
  lines.push(
    `              const e2eResults = parseVitestResults(e2eResultsPath);`
  );
  lines.push(`              `);
  lines.push(`              // Combine dev + e2e results`);
  lines.push(`              results[world.id] = {`);
  lines.push(
    `                passed: (devResults?.passed || 0) + (e2eResults?.passed || 0),`
  );
  lines.push(
    `                failed: (devResults?.failed || 0) + (e2eResults?.failed || 0),`
  );
  lines.push(
    `                skipped: (devResults?.skipped || 0) + (e2eResults?.skipped || 0),`
  );
  lines.push(
    `                total: (devResults?.total || 0) + (e2eResults?.total || 0),`
  );
  lines.push(
    `                hasResults: devResults !== null || e2eResults !== null`
  );
  lines.push(`              };`);
  lines.push(`            }`);
  lines.push(`            `);
  lines.push(
    `            let summary = '## Community Worlds E2E Test Results\\n\\n';`
  );
  lines.push(
    `            summary += '| World | Package | Tests | Passed | Failed | Skipped |${includeBenchmarks ? ' Benchmark |' : ''}\\n';`
  );
  lines.push(
    `            summary += '|:------|:--------|------:|-------:|-------:|--------:|${includeBenchmarks ? ':----------|' : ''}\\n';`
  );
  lines.push(`            `);

  if (includeBenchmarks) {
    lines.push(`            const benchmarkResults = {`);
    for (const world of manifest.worlds) {
      lines.push(
        `              '${world.id}': '\${{ needs.benchmark-${world.id}.result }}',`
      );
    }
    lines.push(`            };`);
    lines.push(`            `);
  }

  lines.push(`            for (const world of worlds) {`);
  lines.push(`              const r = results[world.id];`);
  lines.push(
    `              const status = !r.hasResults ? '⚠️' : r.failed === 0 ? '✅' : '❌';`
  );
  if (includeBenchmarks) {
    lines.push(`              const benchResult = benchmarkResults[world.id];`);
    lines.push(
      `              const benchEmoji = benchResult === 'success' ? '✅' : benchResult === 'failure' ? '❌' : '⏭️';`
    );
    lines.push(
      `              summary += \`| \${status} \${world.name} | \\\`\${world.package}\\\` | \${r.total} | \${r.passed} | \${r.failed} | \${r.skipped} | \${benchEmoji} \${benchResult} |\\n\`;`
    );
  } else {
    lines.push(
      `              summary += \`| \${status} \${world.name} | \\\`\${world.package}\\\` | \${r.total} | \${r.passed} | \${r.failed} | \${r.skipped} |\\n\`;`
    );
  }
  lines.push(`            }`);
  lines.push(`            `);
  lines.push(
    `            summary += '\\n> Tests run with \`continue-on-error: true\` - failures are informational.\\n';`
  );
  lines.push(`            `);
  lines.push(`            await core.summary.addRaw(summary).write();`);

  return lines.join('\n');
}

// Generate E2E workflow
function generateE2EWorkflow(includeBenchmarks = true) {
  const lines = [];

  // Header comment
  lines.push(`# AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY`);
  lines.push(`# This file is generated from community-worlds.json`);
  lines.push(`# Run: node scripts/generate-community-worlds-workflow.mjs`);
  lines.push(``);
  lines.push(`name: Community Worlds Tests`);
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

  // Generate build job (shared by all jobs)
  lines.push(generateBuildJob());
  lines.push(``);

  // Generate E2E jobs for each world
  for (const world of manifest.worlds) {
    lines.push(generateJob(world, true, false));
    lines.push(``);
  }

  // Generate benchmark jobs for each world
  if (includeBenchmarks) {
    for (const world of manifest.worlds) {
      lines.push(generateJob(world, false, true));
      lines.push(``);
    }
  }

  // Generate summary job
  lines.push(generateSummaryJob(includeBenchmarks));
  lines.push(``);

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
