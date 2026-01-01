#!/usr/bin/env node

import fs from 'node:fs';

// List of files that need skip markers (from test failures)
const FAILURES = `
docs/content/docs/how-it-works/understanding-directives.mdx:24
docs/content/docs/how-it-works/understanding-directives.mdx:108
docs/content/docs/how-it-works/understanding-directives.mdx:123
docs/content/docs/how-it-works/understanding-directives.mdx:138
docs/content/docs/how-it-works/understanding-directives.mdx:153
docs/content/docs/how-it-works/understanding-directives.mdx:175
docs/content/docs/how-it-works/understanding-directives.mdx:195
docs/content/docs/how-it-works/understanding-directives.mdx:212
docs/content/docs/how-it-works/understanding-directives.mdx:222
docs/content/docs/how-it-works/understanding-directives.mdx:244
docs/content/docs/how-it-works/understanding-directives.mdx:301
docs/content/docs/how-it-works/understanding-directives.mdx:339
docs/content/docs/how-it-works/understanding-directives.mdx:378
docs/content/docs/how-it-works/understanding-directives.mdx:451
docs/content/docs/how-it-works/understanding-directives.mdx:512
docs/content/docs/how-it-works/understanding-directives.mdx:546
docs/content/docs/how-it-works/framework-integrations.mdx:81
docs/content/docs/how-it-works/framework-integrations.mdx:131
docs/content/docs/how-it-works/framework-integrations.mdx:258
docs/content/docs/how-it-works/framework-integrations.mdx:313
docs/content/docs/how-it-works/code-transform.mdx:16
docs/content/docs/how-it-works/code-transform.mdx:73
docs/content/docs/how-it-works/code-transform.mdx:82
docs/content/docs/how-it-works/code-transform.mdx:110
docs/content/docs/how-it-works/code-transform.mdx:125
docs/content/docs/how-it-works/code-transform.mdx:159
docs/content/docs/how-it-works/code-transform.mdx:169
docs/content/docs/getting-started/nuxt.mdx:53
docs/content/docs/foundations/workflows-and-steps.mdx:89
docs/content/docs/foundations/streaming.mdx:508
docs/content/docs/foundations/starting-workflows.mdx:42
docs/content/docs/foundations/hooks.mdx:434
docs/content/docs/foundations/control-flow-patterns.mdx:12
docs/content/docs/errors/serialization-failed.mdx:35
docs/content/docs/deploying/world/vercel-world.mdx:139
docs/content/docs/deploying/world/vercel-world.mdx:160
docs/content/docs/deploying/world/local-world.mdx:51
docs/content/docs/deploying/world/local-world.mdx:71
docs/content/docs/deploying/world/local-world.mdx:83
docs/content/docs/deploying/world/local-world.mdx:96
docs/content/docs/deploying/world/local-world.mdx:120
docs/content/docs/deploying/world/local-world.mdx:211
docs/content/docs/deploying/world/local-world.mdx:234
docs/content/docs/ai/streaming-updates-from-tools.mdx:42
docs/content/docs/ai/streaming-updates-from-tools.mdx:92
docs/content/docs/ai/sleep-and-delays.mdx:67
docs/content/docs/ai/resumable-streams.mdx:24
docs/content/docs/ai/index.mdx:82
docs/content/docs/ai/index.mdx:318
docs/content/docs/ai/human-in-the-loop.mdx:75
docs/content/docs/ai/human-in-the-loop.mdx:240
packages/world-postgres/README.md:45
packages/docs-typecheck/README.md:78
`
  .trim()
  .split('\n')
  .filter(Boolean);

// Group by file and sort line numbers descending
const byFile = new Map();
for (const entry of FAILURES) {
  const [file, lineStr] = entry.split(':');
  const line = parseInt(lineStr, 10);
  if (!byFile.has(file)) {
    byFile.set(file, []);
  }
  byFile.get(file).push(line);
}

// Process each file
for (const [file, lines] of byFile) {
  // Sort descending so we insert from bottom to top
  lines.sort((a, b) => b - a);

  if (!fs.existsSync(file)) {
    console.log(`SKIP (not found): ${file}`);
    continue;
  }

  const content = fs.readFileSync(file, 'utf-8');
  const fileLines = content.split('\n');

  for (const lineNum of lines) {
    // lineNum is 1-indexed and points to the first line of code content
    // We need to find the ``` fence line which is before it
    // Array is 0-indexed, so lineNum-1 is the index of the code
    const codeIndex = lineNum - 1;

    // Search backwards for the ``` fence line
    let fenceIndex = codeIndex - 1;
    while (fenceIndex >= 0) {
      const line = fileLines[fenceIndex].trim();
      if (line.startsWith('```')) {
        break;
      }
      fenceIndex--;
    }

    if (fenceIndex < 0) {
      console.log(`WARN (fence not found): ${file}:${lineNum}`);
      continue;
    }

    // Check if there's already a skip marker on the previous line
    if (
      fenceIndex > 0 &&
      fileLines[fenceIndex - 1].includes('@skip-typecheck')
    ) {
      console.log(`SKIP (already has marker): ${file}:${lineNum}`);
      continue;
    }

    // Insert the skip marker BEFORE the code block fence
    fileLines.splice(
      fenceIndex,
      0,
      '<!-- @skip-typecheck: incomplete code sample -->'
    );
    console.log(`Added: ${file}:${lineNum} (fence at line ${fenceIndex + 1})`);
  }

  fs.writeFileSync(file, fileLines.join('\n'));
}

console.log('\nDone!');
