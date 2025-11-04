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

  it('should error on Node.js imports from nested npm packages', async () => {
    // This simulates what happens when a package like @supabase/supabase-js
    // internally imports Node.js built-ins. The key is that the import path
    // needs to look like it's coming from node_modules
    const testCode = `
      // Simulating a fake npm package that uses Node.js built-ins
      import { fakePackage } from "./fake-package";
      export function workflow() {
        return fakePackage();
      }
    `;

    const fakePackageCode = `
      // This simulates @supabase/node-fetch or similar packages
      import { Stream } from "stream";
      export function fakePackage() {
        return new Stream();
      }
    `;

    // Create a virtual plugin to provide the fake package
    const virtualModulePlugin: esbuild.Plugin = {
      name: 'virtual-fake-package',
      setup(build) {
        build.onResolve({ filter: /^\.\/fake-package$/ }, () => ({
          path: '/some/path/node_modules/fake-package/index.js', // Make it look like node_modules
          namespace: 'fake-ns',
        }));
        build.onLoad({ filter: /.*/, namespace: 'fake-ns' }, () => ({
          contents: fakePackageCode,
          loader: 'ts',
        }));
      },
    };

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
        plugins: [virtualModulePlugin, createNodeModuleErrorPlugin()],
        logLevel: 'silent',
      })
    ).rejects.toThrow(/Cannot use Node\.js module "stream"/);
  });
});
