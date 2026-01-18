import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import { extractCodeSamples } from '../extractor.js';
import { addInferredImports } from '../import-inference.js';
import { formatResult, typeCheckBatch } from '../type-checker.js';
import type {
  CodeSample,
  ProcessedCodeSample,
  TypeCheckResult,
} from '../types.js';

// Resolve paths relative to repository root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

/**
 * Filter for specific doc files.
 * Set DOCS_FILE env var to filter:
 *   - Full relative path: DOCS_FILE="docs/content/docs/ai/index.mdx"
 *   - Partial match: DOCS_FILE="ai/index"
 *   - Multiple files: DOCS_FILE="hooks.mdx,streaming.mdx"
 */
const docsFileFilter = process.env.DOCS_FILE;

// Find all MDX documentation files
const docsFiles = globSync(path.join(repoRoot, 'docs/content/docs/**/*.mdx'));

// Find package README files
const readmeFiles = globSync(path.join(repoRoot, 'packages/*/README.md'));

// Combine all documentation files - use relative paths for better output
let allDocFiles = [...docsFiles, ...readmeFiles].map((f) =>
  path.relative(repoRoot, f)
);

// Apply filter if DOCS_FILE is set
if (docsFileFilter) {
  const filters = docsFileFilter.split(',').map((f) => f.trim());
  allDocFiles = allDocFiles.filter((file) =>
    filters.some((filter) => file.includes(filter))
  );
  console.log(`Filtering to files matching: ${docsFileFilter}`);
}

console.log('repoRoot:', repoRoot);
console.log('Found files:', allDocFiles.length);

// Collect all samples upfront for batch processing
interface SampleInfo {
  relativeFile: string;
  sample: CodeSample;
  processed?: ProcessedCodeSample;
}

const allSamples: SampleInfo[] = [];
const skippedSamples: SampleInfo[] = [];
const noTsSamplesFiles: string[] = [];

for (const relativeFile of allDocFiles) {
  const filePath = path.join(repoRoot, relativeFile);
  if (!fs.existsSync(filePath)) continue;

  const content = fs.readFileSync(filePath, 'utf-8');
  const samples = extractCodeSamples(filePath, content);

  const tsSamples = samples.filter(
    (s) => s.language === 'typescript' || s.language === 'ts'
  );

  if (tsSamples.length === 0) {
    noTsSamplesFiles.push(relativeFile);
    continue;
  }

  for (const sample of tsSamples) {
    if (sample.skipTypeCheck) {
      skippedSamples.push({ relativeFile, sample });
    } else {
      const processed = addInferredImports(sample);
      allSamples.push({ relativeFile, sample, processed });
    }
  }
}

// Batch type check ALL samples in a single TypeScript program
const batchResults: Map<ProcessedCodeSample, TypeCheckResult> = typeCheckBatch(
  allSamples.map((s) => s.processed!)
);

// Create a lookup for results
const resultsByKey = new Map<string, TypeCheckResult>();
for (const info of allSamples) {
  const key = `${info.relativeFile}:${info.sample.lineNumber}`;
  const result = batchResults.get(info.processed!);
  if (result) {
    resultsByKey.set(key, result);
  }
}

describe('Documentation Code Samples', () => {
  if (allDocFiles.length === 0) {
    it('should find documentation files', () => {
      expect.fail(`No documentation files found in ${repoRoot}`);
    });
    return;
  }

  // Group samples by file for organized output
  const samplesByFile = new Map<string, SampleInfo[]>();
  for (const info of allSamples) {
    const existing = samplesByFile.get(info.relativeFile) || [];
    existing.push(info);
    samplesByFile.set(info.relativeFile, existing);
  }

  const skippedByFile = new Map<string, SampleInfo[]>();
  for (const info of skippedSamples) {
    const existing = skippedByFile.get(info.relativeFile) || [];
    existing.push(info);
    skippedByFile.set(info.relativeFile, existing);
  }

  // Get all unique files
  const allFilesWithSamples = new Set([
    ...samplesByFile.keys(),
    ...skippedByFile.keys(),
    ...noTsSamplesFiles,
  ]);

  for (const relativeFile of allFilesWithSamples) {
    describe(relativeFile, () => {
      // Handle files with no TS samples
      if (noTsSamplesFiles.includes(relativeFile)) {
        it.skip('no TypeScript code samples', () => {});
        return;
      }

      // Handle skipped samples
      const skipped = skippedByFile.get(relativeFile) || [];
      for (const info of skipped) {
        it.skip(`line ${info.sample.lineNumber} (skip marker)`, () => {});
      }

      // Handle actual samples - results are pre-computed
      const samples = samplesByFile.get(relativeFile) || [];
      for (const info of samples) {
        const key = `${info.relativeFile}:${info.sample.lineNumber}`;
        const result = resultsByKey.get(key);

        it(`line ${info.sample.lineNumber}`, () => {
          if (!result) {
            expect.fail('No type check result found');
            return;
          }
          if (!result.success) {
            expect.fail(formatResult(result));
          }
        });
      }
    });
  }
});
