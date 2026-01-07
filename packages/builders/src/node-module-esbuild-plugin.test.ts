import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
// @ts-expect-error - Intentionally unused import for testing getViolationLocation
// with an import that exists but is never referenced in code
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Resolve symlinks in tmpdir to avoid macOS /var -> /private/var issues
const realTmpdir = realpathSync(tmpdir());

import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  createNodeModuleErrorPlugin,
  escapeRegExp,
  getImportedIdentifier,
  getPackageName,
  getViolationLocation,
} from './node-module-esbuild-plugin.js';

async function buildWorkflowWithViolation(
  source: string,
  overrides: Partial<esbuild.BuildOptions> = {}
) {
  const tempDir = mkdtempSync(join(realTmpdir, 'node-module-plugin-test-'));
  const entryFile = join(tempDir, 'workflow.ts');
  writeFileSync(entryFile, source);
  const relativeEntry = relative(process.cwd(), entryFile);

  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      platform: 'neutral',
      logLevel: 'silent',
      plugins: [createNodeModuleErrorPlugin(), ...(overrides.plugins ?? [])],
      ...overrides,
    });
    throw new Error('Expected build to fail');
  } catch (error: any) {
    if (error && typeof error === 'object' && 'errors' in error) {
      return {
        failure: error as esbuild.BuildFailure,
        relativeEntry,
      };
    }
    throw error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('workflow-node-module-error plugin', () => {
  it('should error on fs import', async () => {
    const testCode = `
      import { readFile } from "fs";
      export function workflow() {
        return readFile("test.txt");
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain(
      'You are attempting to use "fs" which is a Node.js module'
    );
    expect(violation.location).toMatchObject({
      file: relativeEntry,
      suggestion: 'Move this function into a step function.',
    });
    expect(violation.location?.line).toBeGreaterThan(0);
    expect(violation.location?.column).toBeGreaterThanOrEqual(0);
    expect(violation.location?.lineText).toContain('readFile');
  });

  it('should error on node: prefixed imports', async () => {
    const testCode = `
      import { readFile } from "node:fs";
      export function workflow() {
        return readFile;
      }
    `;

    const { failure, relativeEntry } = await buildWorkflowWithViolation(
      testCode,
      { format: 'cjs' }
    );

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain(
      'You are attempting to use "node:fs" which is a Node.js module'
    );
    expect(violation.location).toMatchObject({
      file: relativeEntry,
      suggestion: 'Move this function into a step function.',
    });
    expect(violation.location?.lineText).toContain('readFile');
  });

  it('should error on multiple Node.js imports', async () => {
    const testCode = `
      import { readFile } from "fs";
      import { join } from "path";
      export function workflow() {
        return readFile(join("a", "b"));
      }
    `;

    const { failure, relativeEntry } = await buildWorkflowWithViolation(
      testCode,
      { format: 'cjs' }
    );

    expect(failure.errors).toHaveLength(2);

    const packages = failure.errors.map((error) => ({
      text: error.text,
      location: error.location,
    }));

    const fsViolation = packages.find((pkg) => pkg.text.includes('"fs"'));
    const pathViolation = packages.find((pkg) => pkg.text.includes('"path"'));

    expect(fsViolation?.text).toContain('which is a Node.js module');
    expect(pathViolation?.text).toContain('which is a Node.js module');

    expect(fsViolation?.location).toMatchObject({
      file: relativeEntry,
      suggestion: 'Move this function into a step function.',
    });
    expect(fsViolation?.location?.lineText).toContain('readFile');
    expect(pathViolation?.location).toMatchObject({
      file: relativeEntry,
      suggestion: 'Move this function into a step function.',
    });
    expect(pathViolation?.location?.lineText).toContain('join');
  });

  it('should show top-level package name for nested Node.js imports', async () => {
    // This test validates that when a package in node_modules internally uses
    // Node.js built-in modules, the error message shows the top-level package name
    // (e.g., "fake-package") instead of the internal built-in (e.g., "stream").
    //
    // We create a real node_modules directory structure to simulate this scenario.
    const tempDir = mkdtempSync(join(realTmpdir, 'node-module-plugin-test-'));
    const nodeModulesDir = join(tempDir, 'node_modules', 'fake-package');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nodeModulesDir, { recursive: true });

    const fakePackageCode = `
      import { Stream } from "stream";
      export function fakePackage() {
        return new Stream();
      }
    `;
    writeFileSync(join(nodeModulesDir, 'index.js'), fakePackageCode);
    writeFileSync(
      join(nodeModulesDir, 'package.json'),
      JSON.stringify({ name: 'fake-package', main: 'index.js' })
    );

    const testCode = `
      import { fakePackage } from "fake-package";
      export function workflow() {
        return fakePackage();
      }
    `;
    const entryFile = join(tempDir, 'workflow.ts');
    writeFileSync(entryFile, testCode);
    const relativeEntry = relative(process.cwd(), entryFile);

    try {
      await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        platform: 'neutral',
        logLevel: 'silent',
        plugins: [createNodeModuleErrorPlugin()],
      });
      throw new Error('Expected build to fail');
    } catch (error: any) {
      if (error && typeof error === 'object' && 'errors' in error) {
        const failure = error as esbuild.BuildFailure;
        expect(failure.errors).toHaveLength(1);
        const violation = failure.errors[0];
        // Should mention the top-level package "fake-package", not the internal "stream" module
        expect(violation.text).toContain('"fake-package"');
        expect(violation.text).toContain('which depends on Node.js modules');
        expect(violation.text).not.toContain('"stream"');
        expect(violation.location).toMatchObject({
          file: relativeEntry,
        });
      } else {
        throw error;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should find usage of namespace imports', async () => {
    const testCode = `
      import * as fs from "fs";
      export function workflow() {
        return fs.readFile("test.txt");
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain('"fs" which is a Node.js module');
    expect(violation.location).toMatchObject({
      file: relativeEntry,
    });
    expect(violation.location?.lineText).toContain('fs.readFile');
  });

  it('should find usage of default imports', async () => {
    const testCode = `
      import fs from "fs";
      export function workflow() {
        return fs.readFile("test.txt");
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain('"fs" which is a Node.js module');
    expect(violation.location).toMatchObject({
      file: relativeEntry,
    });
    expect(violation.location?.lineText).toContain('fs.readFile');
  });

  it('should find usage of aliased imports', async () => {
    const testCode = `
      import { readFile as read } from "fs";
      export function workflow() {
        return read("test.txt");
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain('"fs" which is a Node.js module');
    expect(violation.location).toMatchObject({
      file: relativeEntry,
    });
    // Should point to the aliased identifier "read", not "readFile"
    expect(violation.location?.lineText).toContain('read(');
  });

  it('should not error when import is unused (tree-shaken)', async () => {
    // Note: esbuild tree-shakes unused imports, so they never trigger resolution.
    // This is expected behavior - if the import isn't used, the module won't be bundled.
    const testCode = `
      import { readFile } from "fs";
      export function workflow() {
        return "no fs usage";
      }
    `;

    const tempDir = mkdtempSync(join(realTmpdir, 'node-module-plugin-test-'));
    const entryFile = join(tempDir, 'workflow.ts');
    writeFileSync(entryFile, testCode);

    try {
      // Build should succeed because unused imports are tree-shaken
      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        platform: 'neutral',
        logLevel: 'silent',
        plugins: [createNodeModuleErrorPlugin()],
      });
      expect(result.errors).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should error on Bun module imports', async () => {
    const testCode = `
      import { serve } from "bun";
      export function workflow() {
        return serve({ port: 3000 });
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain('"bun" which is a Bun module');
    expect(violation.text).toContain('Bun modules are not available');
    expect(violation.location).toMatchObject({
      file: relativeEntry,
    });
  });

  it('should error on Bun subpath imports', async () => {
    const testCode = `
      import { Database } from "bun:sqlite";
      export function workflow() {
        return new Database("test.db");
      }
    `;

    const { failure, relativeEntry } =
      await buildWorkflowWithViolation(testCode);

    expect(failure.errors).toHaveLength(1);
    const violation = failure.errors[0];
    expect(violation.text).toContain('"bun:sqlite" which is a Bun module');
    expect(violation.text).toContain('Bun modules are not available');
    expect(violation.location).toMatchObject({
      file: relativeEntry,
    });
  });
});

describe('workflow-node-module-error helper functions', () => {
  describe('getPackageName', () => {
    it('should get the package name from simple node_modules path', () => {
      const packageName = getPackageName(
        '/Users/adrianlam/GitHub/workflow/node_modules/node-fetch/src/index.js'
      );
      expect(packageName).toBe('node-fetch');
    });

    it('should get the package name from pnpm nested path', () => {
      const packageName = getPackageName(
        '/Users/adrianlam/GitHub/workflow/node_modules/.pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js'
      );
      expect(packageName).toBe('node-fetch');
    });

    it('should get scoped package name', () => {
      const packageName = getPackageName(
        '/project/node_modules/@supabase/supabase-js/dist/index.js'
      );
      expect(packageName).toBe('@supabase/supabase-js');
    });

    it('should return null for paths without node_modules', () => {
      const packageName = getPackageName(
        '/Users/adrianlam/GitHub/workflow/src/index.js'
      );
      expect(packageName).toBeNull();
    });
  });

  describe('escapeRegExp', () => {
    it('should escape regex special characters', () => {
      expect(escapeRegExp('test.file')).toBe('test\\.file');
      expect(escapeRegExp('test*file')).toBe('test\\*file');
      expect(escapeRegExp('test+file')).toBe('test\\+file');
      expect(escapeRegExp('test?file')).toBe('test\\?file');
      expect(escapeRegExp('test^file')).toBe('test\\^file');
      expect(escapeRegExp('test$file')).toBe('test\\$file');
    });

    it('should escape brackets and braces', () => {
      expect(escapeRegExp('test{file}')).toBe('test\\{file\\}');
      expect(escapeRegExp('test[file]')).toBe('test\\[file\\]');
      expect(escapeRegExp('test(file)')).toBe('test\\(file\\)');
    });

    it('should escape pipes and backslashes', () => {
      expect(escapeRegExp('test|file')).toBe('test\\|file');
      expect(escapeRegExp('test\\file')).toBe('test\\\\file');
    });

    it('should handle strings without special characters', () => {
      expect(escapeRegExp('testfile')).toBe('testfile');
      expect(escapeRegExp('test-file')).toBe('test-file');
    });

    it('should handle package names with special characters', () => {
      expect(escapeRegExp('@supabase/supabase-js')).toBe(
        '@supabase/supabase-js'
      );
      expect(escapeRegExp('package.name')).toBe('package\\.name');
    });
  });

  describe('getImportedIdentifier', () => {
    it('should extract namespace import identifier', () => {
      expect(getImportedIdentifier('* as fs')).toBe('fs');
      expect(getImportedIdentifier('*   as   path')).toBe('path');
    });

    it('should extract first named import', () => {
      expect(getImportedIdentifier('{ readFile }')).toBe('readFile');
      expect(getImportedIdentifier('{ readFile, writeFile }')).toBe('readFile');
    });

    it('should extract aliased named import', () => {
      expect(getImportedIdentifier('{ readFile as read }')).toBe('read');
      expect(getImportedIdentifier('{ readFile as read, writeFile }')).toBe(
        'read'
      );
    });

    it('should extract default import', () => {
      expect(getImportedIdentifier('fs')).toBe('fs');
      expect(getImportedIdentifier('myDefault')).toBe('myDefault');
    });

    it('should extract first identifier from mixed imports', () => {
      // The function checks for braces first, so it extracts from named imports
      expect(getImportedIdentifier('fs, { readFile }')).toBe('readFile');
      expect(getImportedIdentifier('defaultExport, { named }')).toBe('named');
    });

    it('should handle whitespace variations', () => {
      expect(getImportedIdentifier('  { readFile }  ')).toBe('readFile');
      expect(getImportedIdentifier('{readFile}')).toBe('readFile');
      expect(getImportedIdentifier('{ readFile , writeFile }')).toBe(
        'readFile'
      );
    });

    it('should handle complex named imports', () => {
      expect(getImportedIdentifier('type { ReadStream }')).toBe('ReadStream');
      expect(getImportedIdentifier('{ default as fs }')).toBe('fs');
    });

    it('should return undefined for edge cases', () => {
      expect(getImportedIdentifier('*')).toBeUndefined();
      expect(getImportedIdentifier('')).toBeUndefined();
      // Empty braces should return undefined since there's no valid identifier
      expect(getImportedIdentifier('{}')).toBeUndefined();
    });
  });

  describe('getViolationLocation', () => {
    it('should find violation location for package name that appears in file', async () => {
      // Use the actual monorepo root as cwd
      const cwd = process.cwd();
      const testFile = 'src/node-module-esbuild-plugin.test.ts';

      // Test with 'vitest' which is actually imported in this file
      const location = await getViolationLocation(cwd, testFile, 'vitest');

      // The function should find 'vitest' in the import statement
      expect(location).toBeDefined();
      expect(location?.file).toBe(testFile);

      const contents = readFileSync(resolve(cwd, testFile), 'utf8');
      const lines = contents.split(/\r?\n/);
      const expectedLine =
        lines.findIndex((line) => line.includes(`describe(`)) + 1;

      expect(location?.line).toBe(expectedLine);
      expect(location?.column).toBe(0);
      expect(location?.lineText).toContain(`describe(`);
      expect(location?.length).toBe(8);
    });

    it('should return undefined for non-existent files', async () => {
      const cwd = process.cwd();
      const location = await getViolationLocation(
        cwd,
        'non-existent-file.ts',
        'some-package'
      );

      expect(location).toBeUndefined();
    });

    it('should return undefined for files without the package import', async () => {
      const cwd = process.cwd();
      const testFile = 'src/node-module-esbuild-plugin.test.ts';

      // This package is not imported in the test file
      const location = await getViolationLocation(
        cwd,
        testFile,
        'non-existent-package'
      );

      expect(location).toBeUndefined();
    });

    it('should return undefined when import is unused even if it can be parsed', async () => {
      const cwd = process.cwd();
      const testFile = 'src/node-module-esbuild-plugin.test.ts';

      // Test with 'node:http' which is imported in this file but never used
      const location = await getViolationLocation(cwd, testFile, 'node:http');

      // Since the identifier is never referenced (only imported), we should
      // not produce a location preview.
      expect(location).toBeUndefined();
    });
  });
});
