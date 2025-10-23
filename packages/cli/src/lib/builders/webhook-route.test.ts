import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../config/types.js';
import { NextBuilder } from './next-build.js';
import { VercelBuildOutputAPIBuilder } from './vercel-build-output-api.js';

describe('Webhook route generation', () => {
  const testDir = join(process.cwd(), '.test-webhook-routes');
  const appDir = join(testDir, 'app');

  beforeEach(async () => {
    await mkdir(appDir, { recursive: true });
    // Create a dummy route file to satisfy NextBuilder's findAppDirectory
    await mkdir(join(appDir, 'test'), { recursive: true });
    await mkdir(join(appDir, 'test'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Next.js build target', () => {
    it('should create webhook route at correct location', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'next',
        dirs: ['app'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new NextBuilder(config);

      // We'll call the private method indirectly through reflection
      const createWebhookBundle = (builder as any).createWebhookBundle.bind(
        builder
      );
      const workflowGeneratedDir = join(appDir, '.well-known/workflow/v1');
      const webhookRouteFile = join(
        workflowGeneratedDir,
        'webhook/[token]/route.js'
      );

      await createWebhookBundle({
        outfile: webhookRouteFile,
        bundle: false,
      });

      const routePath = join(workflowGeneratedDir, 'webhook/[token]/route.js');
      const routeContent = await readFile(routePath, 'utf-8');

      expect(routeContent).toContain('resumeWebhook');
      expect(routeContent).toContain('async function handler(request)');
      expect(routeContent).toContain("url.pathname.split('/')");
      expect(routeContent).toContain(
        'decodeURIComponent(pathParts[pathParts.length - 1])'
      );
      expect(routeContent).toContain('export const GET = handler');
      expect(routeContent).toContain('export const POST = handler');
      expect(routeContent).toContain('export const PUT = handler');
      expect(routeContent).toContain('export const PATCH = handler');
      expect(routeContent).toContain('export const DELETE = handler');
    });

    it('should handle missing token correctly', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'next',
        dirs: ['app'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new NextBuilder(config);
      const createWebhookBundle = (builder as any).createWebhookBundle.bind(
        builder
      );
      const workflowGeneratedDir = join(appDir, '.well-known/workflow/v1');
      const webhookRouteFile = join(
        workflowGeneratedDir,
        'webhook/[token]/route.js'
      );

      await createWebhookBundle({
        outfile: webhookRouteFile,
        bundle: false,
      });

      const routeContent = await readFile(webhookRouteFile, 'utf-8');

      expect(routeContent).toContain('Missing token');
      expect(routeContent).toContain('status: 400');
    });

    it('should handle webhook not found correctly', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'next',
        dirs: ['app'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new NextBuilder(config);
      const createWebhookBundle = (builder as any).createWebhookBundle.bind(
        builder
      );
      const workflowGeneratedDir = join(appDir, '.well-known/workflow/v1');
      const webhookRouteFile = join(
        workflowGeneratedDir,
        'webhook/[token]/route.js'
      );

      await createWebhookBundle({
        outfile: webhookRouteFile,
        bundle: false,
      });

      const routeContent = await readFile(webhookRouteFile, 'utf-8');

      expect(routeContent).toContain('new Response(null, { status: 404 })');
    });
  });

  describe('Build Output API build target', () => {
    it('should create webhook function at correct location', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'vercel-build-output-api',
        dirs: ['workflows'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new VercelBuildOutputAPIBuilder(config);
      const createWebhookBundle = (builder as any).createWebhookBundle.bind(
        builder
      );
      const workflowGeneratedDir = join(
        testDir,
        '.vercel/output/functions/.well-known/workflow/v1'
      );
      const webhookFuncFile = join(
        workflowGeneratedDir,
        'webhook/[token].func/index.js'
      );

      // Don't actually bundle in tests since it requires workflow to be installed
      // Just verify the unbundled route generation works
      await createWebhookBundle({
        outfile: webhookFuncFile,
        bundle: false,
      });

      const funcContent = await readFile(webhookFuncFile, 'utf-8');

      // Check that the route content was generated correctly
      expect(funcContent).toContain('workflow/api');
      expect(funcContent).toContain('async function handler');
      expect(funcContent).toContain('export const POST = handler');
    });

    it('should create correct .vc-config.json', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'vercel-build-output-api',
        dirs: ['workflows'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new VercelBuildOutputAPIBuilder(config);
      const buildWebhookFunction = (builder as any).buildWebhookFunction.bind(
        builder
      );
      const workflowGeneratedDir = join(
        testDir,
        '.vercel/output/functions/.well-known/workflow/v1'
      );

      await mkdir(workflowGeneratedDir, { recursive: true });
      await buildWebhookFunction({
        inputFiles: [],
        workflowGeneratedDir,
        bundle: false, // Skip bundling in tests (requires workflow installed)
      });

      const configPath = join(
        workflowGeneratedDir,
        'webhook/[token].func/.vc-config.json'
      );
      const configContent = await readFile(configPath, 'utf-8');
      const config_parsed = JSON.parse(configContent);

      expect(config_parsed.runtime).toBe('nodejs22.x');
      expect(config_parsed.handler).toBe('index.js');
      expect(config_parsed.launcherType).toBe('Nodejs');
      expect(config_parsed.shouldAddHelpers).toBe(false);
      expect(config_parsed.useWebApi).toBeUndefined();
    });

    it('should use CommonJS module format', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'vercel-build-output-api',
        dirs: ['workflows'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new VercelBuildOutputAPIBuilder(config);
      const buildWebhookFunction = (builder as any).buildWebhookFunction.bind(
        builder
      );
      const workflowGeneratedDir = join(
        testDir,
        '.vercel/output/functions/.well-known/workflow/v1'
      );

      await mkdir(workflowGeneratedDir, { recursive: true });
      await buildWebhookFunction({
        inputFiles: [],
        workflowGeneratedDir,
        bundle: false, // Skip bundling in tests (requires workflow installed)
      });

      const packageJsonPath = join(
        workflowGeneratedDir,
        'webhook/[token].func/package.json'
      );
      const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      expect(packageJson.type).toBe('commonjs');
    });

    it('should add route configuration for dynamic segment', async () => {
      const config: WorkflowConfig = {
        buildTarget: 'vercel-build-output-api',
        dirs: ['workflows'],
        workingDir: testDir,
        stepsBundlePath: '',
        workflowsBundlePath: '',
        watch: false,
        externalPackages: [],
      };

      const builder = new VercelBuildOutputAPIBuilder(config);
      const createBuildOutputConfig = (
        builder as any
      ).createBuildOutputConfig.bind(builder);
      const outputDir = join(testDir, '.vercel/output');

      await mkdir(outputDir, { recursive: true });
      await createBuildOutputConfig(outputDir);

      const configPath = join(outputDir, 'config.json');
      const configContent = await readFile(configPath, 'utf-8');
      const config_parsed = JSON.parse(configContent);

      expect(config_parsed.version).toBe(3);
      expect(config_parsed.routes).toBeDefined();
      expect(config_parsed.routes).toHaveLength(1);
      expect(config_parsed.routes[0].src).toBe(
        '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$'
      );
      expect(config_parsed.routes[0].dest).toBe(
        '/.well-known/workflow/v1/webhook/[token]'
      );
    });
  });
});
