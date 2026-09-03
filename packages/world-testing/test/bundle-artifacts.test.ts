import { readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('publishes every lazy workflow bundle with the flow route', async () => {
  const sourceBundlesDirectory = new URL(
    '../.well-known/workflow/v1/workflow-bundles/',
    import.meta.url
  );
  const publishedBundlesDirectory = new URL(
    '../dist/.well-known/workflow/v1/workflow-bundles/',
    import.meta.url
  );
  const readBundleFiles = async (directory: URL) =>
    (await readdir(directory)).filter((file) => file.endsWith('.mjs')).sort();
  const sourceFiles = await readBundleFiles(sourceBundlesDirectory);
  const publishedFiles = await readBundleFiles(publishedBundlesDirectory);

  expect(sourceFiles.length).toBeGreaterThan(0);
  expect(sourceFiles.every((file) => /^[a-f0-9]{64}\.mjs$/.test(file))).toBe(
    true
  );
  expect(publishedFiles).toEqual(sourceFiles);

  for (const file of publishedFiles) {
    const bundle = await import(new URL(file, publishedBundlesDirectory).href);
    expect(bundle.default).toEqual(expect.any(String));
  }
});
