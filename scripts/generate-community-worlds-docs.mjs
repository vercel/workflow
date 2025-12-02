#!/usr/bin/env node

/**
 * Generates the Community Worlds section in docs/content/docs/deploying/world/index.mdx
 *
 * Usage: node scripts/generate-community-worlds-docs.mjs
 *
 * This script reads the community-worlds.json manifest and updates the
 * Community Worlds section in the docs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read the manifest
const manifestPath = path.join(rootDir, 'community-worlds.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// Generate the community worlds list
function generateCommunityWorldsList() {
  const lines = [];
  lines.push('## Community Worlds');
  lines.push('');
  lines.push(
    '> These worlds are maintained by the community and tested in CI. See the [community-worlds.json](https://github.com/vercel/workflow/blob/main/community-worlds.json) manifest for configuration details.'
  );
  lines.push('');

  for (const world of manifest.worlds) {
    const name = world.name;
    const pkg = world.package;
    const description = world.description;
    const docsLink = world.docs || world.repository;

    lines.push(`- [${name}](${docsLink}) (\`${pkg}\`) - ${description}`);
  }

  lines.push('');
  lines.push('### Other Community Worlds');
  lines.push('');
  lines.push(
    '- [Postgres World](/docs/deploying/world/postgres-world) - Reference implementation for a multi-host PostgreSQL backend world.'
  );
  lines.push(
    '- [Jazz World](https://github.com/garden-co/workflow-world-jazz) - A full World implementation built on top of [Jazz](https://jazz.tools)'
  );

  return lines.join('\n');
}

// Read the existing docs file
const docsPath = path.join(
  rootDir,
  'docs/content/docs/deploying/world/index.mdx'
);
let docsContent = fs.readFileSync(docsPath, 'utf-8');

// Find and replace the Community Worlds section
// Match from "## Community Worlds" to the end of the file (it's the last section)
const communityWorldsRegex = /## Community Worlds[\s\S]*$/;
const newSection = generateCommunityWorldsList();

if (communityWorldsRegex.test(docsContent)) {
  docsContent = docsContent.replace(communityWorldsRegex, newSection);
} else {
  // If section doesn't exist, append it before the end
  docsContent = docsContent.trim() + '\n\n' + newSection + '\n';
}

// Write the updated docs
fs.writeFileSync(docsPath, docsContent);

console.log(`Updated ${docsPath}`);
console.log(`  - ${manifest.worlds.length} community world(s) documented`);
for (const world of manifest.worlds) {
  console.log(`    - ${world.name} (${world.package})`);
}
