import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { createNodeModuleErrorPlugin } from './node-module-esbuild-plugin.js';

describe('workflow-node-module-error plugin', () => {
  it('should error on fs import', async () => {
    const testCode = `
      import { readFile } from "fs";
      export function workflow() {
        return readFile("test.txt");
      }
    `;

    await expect(
      esbuild.build({
        stdin: {
          contents: testCode,
          resolveDir: process.cwd(),
          sourcefile: 'test-workflow.ts',
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'neutral',
        plugins: [createNodeModuleErrorPlugin()],
        logLevel: 'silent',
      })
    ).rejects.toThrow(/Cannot use Node\.js module "fs"/);
  });

  it('should error on path import', async () => {
    const testCode = `
      import { join } from "path";
      export function workflow() {
        return join("a", "b");
      }
    `;

    await expect(
      esbuild.build({
        stdin: {
          contents: testCode,
          resolveDir: process.cwd(),
          sourcefile: 'test-workflow.ts',
          loader: 'ts',
        },
        format: 'cjs',
        bundle: true,
        write: false,
        platform: 'neutral',
        plugins: [createNodeModuleErrorPlugin()],
        logLevel: 'silent',
      })
    ).rejects.toThrow(/Cannot use Node\.js module "path"/);
  });

  it('should error on node: prefixed imports', async () => {
    const testCode = `
      import { readFile } from "node:fs";
      export function workflow() {
        return readFile;
      }
    `;

    await expect(
      esbuild.build({
        stdin: {
          contents: testCode,
          resolveDir: process.cwd(),
          sourcefile: 'test-workflow.ts',
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        plugins: [createNodeModuleErrorPlugin()],
        logLevel: 'silent',
      })
    ).rejects.toThrow(/Cannot use Node\.js module/);
  });

  it('should error on multiple Node.js imports', async () => {
    const testCode = `
      import { readFile } from "fs";
      import { join } from "path";
      export function workflow() {
        return readFile(join("a", "b"));
      }
    `;

    const result = esbuild.build({
      stdin: {
        contents: testCode,
        resolveDir: process.cwd(),
        sourcefile: 'test-workflow.ts',
        loader: 'ts',
      },
      format: 'cjs',
      bundle: true,
      write: false,
      platform: 'neutral',
      plugins: [createNodeModuleErrorPlugin()],
      logLevel: 'silent',
    });

    await expect(result).rejects.toThrow();

    // Verify we get errors for both imports
    try {
      await result;
    } catch (error: any) {
      expect(error.message).toMatch(/fs/);
      expect(error.message).toMatch(/path/);
    }
  });

  it('should allow non-Node.js npm package imports', async () => {
    const testCode = `
    // This should NOT error - it's not a built-in Node.js module
      import { someFunction } from "some-random-package";
      export function workflow() {
        return "ok";
      }
    `;

    // This will fail because the package doesn't exist, but it shouldn't
    // fail with our plugin's error message
    await expect(
      esbuild.build({
        stdin: {
          contents: testCode,
          resolveDir: process.cwd(),
          sourcefile: 'test-workflow.ts',
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'neutral',
        plugins: [createNodeModuleErrorPlugin()],
        logLevel: 'silent',
        external: ['some-random-package'], // Mark as external so it doesn't fail resolution
      })
    ).resolves.toBeDefined();
  });

  it('should allow Node.js imports from workspace packages outside working directory', async () => {
    // This test simulates a monorepo workspace package importing Node.js modules
    // The plugin should NOT error because the import is from an external package

    // Mock an onResolve call that would happen for a workspace package
    let resolveHandler: any;
    const mockPlugin = createNodeModuleErrorPlugin();
    const mockBuild = {
      initialOptions: {
        absWorkingDir: '/Users/test/project/apps/web',
      },
      onResolve: (_opts: any, handler: any) => {
        resolveHandler = handler;
      },
    };

    // Setup the plugin
    mockPlugin.setup(mockBuild as any);

    // Test that imports from workspace packages (outside working dir) are allowed
    // This simulates an import of 'crypto' from a workspace package
    const result = resolveHandler({
      path: 'crypto',
      importer: '/Users/test/project/packages/database/dist/index.js', // Outside working dir
    });

    // Should return null (no error) because it's from a workspace package
    expect(result).toBeNull();
  });

  it('should still error on Node.js imports from project source', async () => {
    // Mock an onResolve call for an import from within the project
    let resolveHandler: any;
    const mockPlugin = createNodeModuleErrorPlugin();
    const mockBuild = {
      initialOptions: {
        absWorkingDir: '/Users/test/project/apps/web',
      },
      onResolve: (_opts: any, handler: any) => {
        resolveHandler = handler;
      },
    };

    // Setup the plugin
    mockPlugin.setup(mockBuild as any);

    // Test that imports from within the project are still blocked
    const result = resolveHandler({
      path: 'fs',
      importer: '/Users/test/project/apps/web/workflows/my-workflow.ts', // Within working dir
    });

    // Should return an error because it's from project source code
    expect(result).toBeDefined();
    expect(result?.errors?.[0]?.text).toContain('Cannot use Node.js module');
  });
});
