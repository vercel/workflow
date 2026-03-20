import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('observability docs stay aligned with requestId correlation guidance', () => {
  it('documents requestId as a machine-readable field distinct from correlationId', () => {
    const observabilityDoc = read('docs/content/docs/observability/index.mdx');
    const eventSourcingDoc = read(
      'docs/content/docs/how-it-works/event-sourcing.mdx'
    );

    expect(observabilityDoc).toContain('requestId');
    expect(observabilityDoc).toContain('platform request logs');

    expect(eventSourcingDoc).toContain('requestId');
    expect(eventSourcingDoc).toContain('correlationId');
    expect(eventSourcingDoc).toContain('platform-log correlation');
  });
});
