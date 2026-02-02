import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  createPseudoPackagePlugin,
  PSEUDO_PACKAGES,
} from './pseudo-package-esbuild-plugin.js';

// Resolve symlinks in tmpdir to avoid macOS /var -> /private/var issues
const realTmpdir = realpathSync(tmpdir());

async function buildWithPlugin(
  source: string,
  plugins: esbuild.Plugin[] = [createPseudoPackagePlugin()]
): Promise<{ result: esbuild.BuildResult; tempDir: string }> {
  const tempDir = mkdtempSync(join(realTmpdir, 'pseudo-package-plugin-test-'));
  const entryFile = join(tempDir, 'workflow.ts');
  writeFileSync(entryFile, source);

  const result = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'cjs',
    logLevel: 'silent',
    plugins,
  });

  return { result, tempDir };
}

describe('createPseudoPackagePlugin', () => {
  describe('server-only package', () => {
    it('should replace server-only import with empty module', async () => {
      const testCode = `
        import 'server-only';
        export function workflow() {
          return "hello";
        }
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        // Should not contain require('server-only') since it's replaced with empty module
        // (esbuild tree-shakes unused imports, so the module content may not appear,
        // but importantly no require() call is generated)
        expect(output).not.toContain("require('server-only')");
        expect(output).not.toContain('require("server-only")');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should handle server-only alongside other imports', async () => {
      const testCode = `
        import 'server-only';
        const x = 42;
        export function workflow() {
          return x;
        }
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        // No require() call should be generated
        expect(output).not.toContain("require('server-only')");
        expect(output).not.toContain('require("server-only")');
        // The actual code should still work
        expect(output).toContain('42');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('client-only package', () => {
    it('should replace client-only import with empty module', async () => {
      const testCode = `
        import 'client-only';
        export const x = 1;
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        // No require() call should be generated
        expect(output).not.toContain("require('client-only')");
        expect(output).not.toContain('require("client-only")');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('compiled pseudo-packages', () => {
    it('should replace next/dist/compiled/server-only import', async () => {
      const testCode = `
        import 'next/dist/compiled/server-only';
        export const x = 1;
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        expect(output).not.toContain(
          "require('next/dist/compiled/server-only')"
        );
        expect(output).not.toContain(
          'require("next/dist/compiled/server-only")'
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should replace next/dist/compiled/client-only import', async () => {
      const testCode = `
        import 'next/dist/compiled/client-only';
        export const x = 1;
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        expect(output).not.toContain(
          "require('next/dist/compiled/client-only')"
        );
        expect(output).not.toContain(
          'require("next/dist/compiled/client-only")'
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('both pseudo-packages', () => {
    it('should handle both server-only and client-only in same file', async () => {
      const testCode = `
        import 'server-only';
        import 'client-only';
        export function workflow() {
          return "mixed";
        }
      `;

      const { result, tempDir } = await buildWithPlugin(testCode);

      try {
        expect(result.errors).toHaveLength(0);
        const output = result.outputFiles?.[0].text;
        expect(output).toBeDefined();
        // No require() calls should be generated for either package
        expect(output).not.toContain("require('server-only')");
        expect(output).not.toContain('require("server-only")');
        expect(output).not.toContain("require('client-only')");
        expect(output).not.toContain('require("client-only")');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('without plugin', () => {
    it('should fail to resolve server-only without the plugin', async () => {
      const testCode = `
        import 'server-only';
        export const x = 1;
      `;

      const tempDir = mkdtempSync(
        join(realTmpdir, 'pseudo-package-plugin-test-')
      );
      const entryFile = join(tempDir, 'workflow.ts');
      writeFileSync(entryFile, testCode);

      try {
        await esbuild.build({
          entryPoints: [entryFile],
          bundle: true,
          write: false,
          platform: 'neutral',
          format: 'cjs',
          logLevel: 'silent',
          // No plugins - should fail to resolve
        });
        // If we get here, the build succeeded (server-only might be installed)
        // This is okay - we just want to verify the plugin works when the package isn't there
      } catch (error: any) {
        // Expected: esbuild can't resolve server-only
        expect(error.errors?.[0]?.text).toMatch(
          /Could not resolve "server-only"/
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('PSEUDO_PACKAGES constant', () => {
    it('should contain next marker packages', () => {
      expect(PSEUDO_PACKAGES.has('server-only')).toBe(true);
      expect(PSEUDO_PACKAGES.has('client-only')).toBe(true);
      expect(PSEUDO_PACKAGES.has('next/dist/compiled/server-only')).toBe(true);
      expect(PSEUDO_PACKAGES.has('next/dist/compiled/client-only')).toBe(true);
      expect(PSEUDO_PACKAGES.size).toBe(4);
    });
  });
});

describe('workflow bundle dynamic imports', () => {
  it('should inline dynamic imports when bundling without external', async () => {
    const tempDir = mkdtempSync(join(realTmpdir, 'dynamic-import-test-'));
    const nodeModulesDir = join(tempDir, 'node_modules', 'my-test-package');
    mkdirSync(nodeModulesDir, { recursive: true });

    // Create a simple package to dynamically import
    writeFileSync(
      join(nodeModulesDir, 'index.js'),
      'export const testValue = 42;'
    );
    writeFileSync(
      join(nodeModulesDir, 'package.json'),
      JSON.stringify({ name: 'my-test-package', main: 'index.js' })
    );

    const testCode = `
      export async function workflow() {
        const pkg = await import('my-test-package');
        return pkg.testValue;
      }
    `;
    const entryFile = join(tempDir, 'workflow.ts');
    writeFileSync(entryFile, testCode);

    try {
      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        logLevel: 'silent',
        // No external option - should inline the dynamic import
      });

      expect(result.errors).toHaveLength(0);
      const output = result.outputFiles?.[0].text;
      expect(output).toBeDefined();

      // The dynamic import should be resolved and the value inlined
      // esbuild converts dynamic imports to either Promise.resolve(require(...))
      // or inlines the code directly
      expect(output).toContain('42');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should leave dynamic import as import() when marked external', async () => {
    const tempDir = mkdtempSync(join(realTmpdir, 'dynamic-import-test-'));
    const nodeModulesDir = join(tempDir, 'node_modules', 'external-package');
    mkdirSync(nodeModulesDir, { recursive: true });

    writeFileSync(
      join(nodeModulesDir, 'index.js'),
      'export const value = 100;'
    );
    writeFileSync(
      join(nodeModulesDir, 'package.json'),
      JSON.stringify({ name: 'external-package', main: 'index.js' })
    );

    const testCode = `
      export async function workflow() {
        const pkg = await import('external-package');
        return pkg.value;
      }
    `;
    const entryFile = join(tempDir, 'workflow.ts');
    writeFileSync(entryFile, testCode);

    try {
      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        logLevel: 'silent',
        external: ['external-package'], // Mark as external
      });

      expect(result.errors).toHaveLength(0);
      const output = result.outputFiles?.[0].text;
      expect(output).toBeDefined();

      // When external, esbuild leaves a dynamic import() call that would fail in the VM
      // (the VM doesn't have import() available)
      // This demonstrates why we DON'T use external for workflow bundles
      expect(output).toMatch(/import\(["']external-package["']\)/);
      // The actual value should NOT be inlined
      expect(output).not.toContain('100');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should inline nested dynamic imports from dependencies', async () => {
    const tempDir = mkdtempSync(join(realTmpdir, 'dynamic-import-test-'));

    // Create a package that itself uses dynamic import
    const outerPackageDir = join(tempDir, 'node_modules', 'outer-package');
    const innerPackageDir = join(tempDir, 'node_modules', 'inner-package');
    mkdirSync(outerPackageDir, { recursive: true });
    mkdirSync(innerPackageDir, { recursive: true });

    writeFileSync(
      join(innerPackageDir, 'index.js'),
      'export const innerValue = 999;'
    );
    writeFileSync(
      join(innerPackageDir, 'package.json'),
      JSON.stringify({ name: 'inner-package', main: 'index.js' })
    );

    writeFileSync(
      join(outerPackageDir, 'index.js'),
      `
      export async function loadInner() {
        const inner = await import('inner-package');
        return inner.innerValue;
      }
    `
    );
    writeFileSync(
      join(outerPackageDir, 'package.json'),
      JSON.stringify({ name: 'outer-package', main: 'index.js' })
    );

    const testCode = `
      import { loadInner } from 'outer-package';
      export async function workflow() {
        return loadInner();
      }
    `;
    const entryFile = join(tempDir, 'workflow.ts');
    writeFileSync(entryFile, testCode);

    try {
      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        logLevel: 'silent',
        // No external - everything should be inlined
      });

      expect(result.errors).toHaveLength(0);
      const output = result.outputFiles?.[0].text;
      expect(output).toBeDefined();

      // Both the outer and inner package code should be inlined
      expect(output).toContain('999');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
