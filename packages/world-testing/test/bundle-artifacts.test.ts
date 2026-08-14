import { readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('publishes every lazy workflow bundle with the flow route', async () => {
  const bundlesDirectory = new URL(
    '../dist/.well-known/workflow/v1/workflow-bundles/',
    import.meta.url
  );
  const files = (await readdir(bundlesDirectory)).filter((file) =>
    file.endsWith('.mjs')
  );

  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const bundle = await import(new URL(file, bundlesDirectory).href);
    expect(bundle.default).toEqual(expect.any(String));
  }
});
