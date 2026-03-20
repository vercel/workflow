import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

function countByValue(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

describe('DurableAgent docs keep skip markers narrow and intentional', () => {
  it('limits @skip-typecheck markers to the known published-type gaps', () => {
    const doc = read(
      'docs/content/docs/api-reference/workflow-ai/durable-agent.mdx'
    );

    const markers = [...doc.matchAll(/@skip-typecheck\s*[-:]\s*([^\n*}]+)/g)].map(
      (match) => match[1].trim().replace(/\s+/g, ' ')
    );

    const markerCounts = countByValue(markers);

    // Log machine-readable marker counts for agent inspection
    console.log(JSON.stringify({ skipMarkerCounts: markerCounts }, null, 2));

    expect(markerCounts).toEqual({
      'uses DurableAgentOptions properties not yet in published dist types': 1,
      'uses DurableAgentOptions.instructions not yet in published dist types': 1,
      'uses DurableAgentStreamOptions.prepareStep not yet in published dist types': 2,
      'uses OutputSpecification not yet in published dist types': 1,
      'uses collectUIMessages/uiMessages not yet in published dist types': 1,
      'uses toolCalls/toolResults not yet in published dist types': 1,
      'uses DurableAgentStreamOptions.timeout not yet in published dist types': 1,
    });
  });
});
