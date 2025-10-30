import builtinModules from 'builtin-modules';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('workflow bundle with Node.js built-ins externalized', () => {
  it('should successfully bundle code that imports Node.js built-ins when marked as external', async () => {
    // This test simulates what happens when a workflow function imports
    // a package (like Supabase) that internally uses Node.js built-ins.
    // With our fix, the build should succeed because built-ins are externalized.
    const testCode = `
      // Simulate a package that uses Node.js built-ins internally
      const Stream = require('stream');
      const http = require('http');
      const https = require('https');
      
      function createClient(url, key) {
        // This simulates the Supabase client which uses node-fetch
        // which in turn uses Node.js built-ins
        return { url, key, Stream, http, https };
      }
      
      // Workflow function that uses the client
      export function myWorkflow() {
        const client = createClient('https://example.com', 'key123');
        return client;
      }
    `;

    const result = await esbuild.build({
      stdin: {
        contents: testCode,
        resolveDir: process.cwd(),
        sourcefile: 'test-workflow.js',
        loader: 'js',
      },
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'cjs',
      // This is the key fix: externalize Node.js built-ins
      external: [...builtinModules],
      logLevel: 'silent',
    });

    expect(result).toBeDefined();
    expect(result.outputFiles).toHaveLength(1);

    const output = result.outputFiles[0].text;

    // Verify that Node.js built-ins are kept as require() calls (externalized)
    expect(output).toContain('require("stream")');
    expect(output).toContain('require("http")');
    expect(output).toContain('require("https")');
  });

  it('should fail to bundle when Node.js built-ins are NOT externalized', async () => {
    const testCode = `
      const Stream = require('stream');
      export function myWorkflow() {
        return Stream;
      }
    `;

    // Without externalizing built-ins, the build should fail
    await expect(
      esbuild.build({
        stdin: {
          contents: testCode,
          resolveDir: process.cwd(),
          sourcefile: 'test-workflow.js',
          loader: 'js',
        },
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'cjs',
        // No external configuration - should fail
        logLevel: 'silent',
      })
    ).rejects.toThrow(/Could not resolve "stream"/);
  });

  it('should handle packages with deep Node.js built-in dependencies', async () => {
    // Simulate a real-world scenario where a package has nested dependencies
    // that use Node.js built-ins (like @supabase/node-fetch)
    const testCode = `
      // Simulate @supabase/node-fetch structure
      const Stream = require('stream');
      const http = require('http');
      const https = require('https');
      const zlib = require('zlib');
      const url = require('url');
      
      function nodeFetch(url, options) {
        return { url, options, Stream, http, https, zlib };
      }
      
      // Simulate @supabase/supabase-js
      function createSupabaseClient(supabaseUrl, supabaseKey) {
        return {
          fetch: nodeFetch,
          from: (table) => ({
            select: () => ({ eq: () => ({ single: () => Promise.resolve({}) }) })
          })
        };
      }
      
      // User's workflow code
      export function checkDatabase(userId) {
        const supabase = createSupabaseClient('url', 'key');
        return supabase.from('users').select('*');
      }
    `;

    const result = await esbuild.build({
      stdin: {
        contents: testCode,
        resolveDir: process.cwd(),
        sourcefile: 'test-workflow.js',
        loader: 'js',
      },
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'cjs',
      external: [...builtinModules],
      logLevel: 'silent',
    });

    expect(result).toBeDefined();
    expect(result.outputFiles).toHaveLength(1);

    const output = result.outputFiles[0].text;

    // All Node.js built-ins should be externalized
    expect(output).toContain('require("stream")');
    expect(output).toContain('require("http")');
    expect(output).toContain('require("https")');
    expect(output).toContain('require("zlib")');
    expect(output).toContain('require("url")');
  });
});
