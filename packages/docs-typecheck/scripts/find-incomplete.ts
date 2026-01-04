import { globSync } from 'glob';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCodeSamples } from '../dist/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const docsFiles = globSync(path.join(repoRoot, 'docs/content/docs/**/*.mdx'));

for (const file of docsFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  const samples = extractCodeSamples(file, content);

  for (const sample of samples) {
    if (
      (sample.language === 'typescript' || sample.language === 'ts') &&
      sample.isIncomplete
    ) {
      const relPath = path.relative(repoRoot, file);
      console.log(`${relPath}:${sample.lineNumber}`);
    }
  }
}
