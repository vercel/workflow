import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('server-based testing docs stay aligned with actionable setup diagnostics', () => {
  it('shows machine-readable setup logs and debuggable startup failures', () => {
    const doc = read('docs/content/docs/testing/server-based.mdx');

    expect(doc).toContain('JSON.stringify');
    expect(doc).toContain('scope: "workflow-server-test"');
    expect(doc).toContain('server_starting');
    expect(doc).toContain('server_stdout');
    expect(doc).toContain('server_stderr');
    expect(doc).toContain('server_ready');
    expect(doc).toContain('server_exit');
    expect(doc).toContain('Server failed to start within 15 seconds.');
    expect(doc).toContain('WORKFLOW_LOCAL_BASE_URL');
    expect(doc).toContain('Recent stdout:');
    expect(doc).toContain('Recent stderr:');
  });
});
