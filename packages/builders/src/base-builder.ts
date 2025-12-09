import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { parse } from 'comment-json';
import enhancedResolveOriginal from 'enhanced-resolve';
import * as esbuild from 'esbuild';
import { findUp } from 'find-up';
import { glob } from 'tinyglobby';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { createDiscoverEntriesPlugin } from './discover-entries-esbuild-plugin.js';
import { createNodeModuleErrorPlugin } from './node-module-esbuild-plugin.js';
import { createSwcPlugin } from './swc-esbuild-plugin.js';
import type { WorkflowConfig } from './types.js';

const enhancedResolve = promisify(enhancedResolveOriginal);

const EMIT_SOURCEMAPS_FOR_DEBUGGING =
  process.env.WORKFLOW_EMIT_SOURCEMAPS_FOR_DEBUGGING === '1';

/**
 * Base class for workflow builders. Provides common build logic for transforming
 * workflow source files into deployable bundles using esbuild and SWC.
 *
 * Subclasses must implement the build() method to define builder-specific logic.
 */
export abstract class BaseBuilder {
  protected config: WorkflowConfig;

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  /**
   * Performs the complete build process for workflows.
   * Subclasses must implement this to define their specific build steps.
   */
  abstract build(): Promise<void>;

  /**
   * Extracts TypeScript path mappings and baseUrl from tsconfig.json/jsconfig.json.
   * Used to properly resolve module imports during bundling.
   */
  protected async getTsConfigOptions(): Promise<{
    baseUrl?: string;
    paths?: Record<string, string[]>;
  }> {
    const options: {
      paths?: Record<string, string[]>;
      baseUrl?: string;
    } = {};

    const cwd = this.config.workingDir || process.cwd();

    const tsJsConfig = await findUp(['tsconfig.json', 'jsconfig.json'], {
      cwd,
    });

    if (tsJsConfig) {
      try {
        const rawJson = await readFile(tsJsConfig, 'utf8');
        const parsed: null | {
          compilerOptions?: {
            paths?: Record<string, string[]> | undefined;
            baseUrl?: string;
          };
        } = parse(rawJson) as any;

        if (parsed) {
          options.paths = parsed.compilerOptions?.paths;

          if (parsed.compilerOptions?.baseUrl) {
            options.baseUrl = resolve(cwd, parsed.compilerOptions.baseUrl);
          } else {
            options.baseUrl = cwd;
          }
        }
      } catch (err) {
        console.error(
          `Failed to parse ${tsJsConfig} aliases might not apply properly`,
          err
        );
      }
    }

    return options;
  }

  /**
   * Discovers all source files in the configured directories.
   * Searches for TypeScript and JavaScript files while excluding common build
   * and dependency directories.
   */
  protected async getInputFiles(): Promise<string[]> {
    const patterns = this.config.dirs.map((dir) => {
      const resolvedDir = resolve(this.config.workingDir, dir);
      // Normalize path separators to forward slashes for glob compatibility
      const normalizedDir = resolvedDir.replace(/\\/g, '/');
      return `${normalizedDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
    });

    const result = await glob(patterns, {
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.next/**',
        '**/.vercel/**',
        '**/.workflow-data/**',
        '**/.well-known/workflow/**',
        '**/.svelte-kit/**',
      ],
      absolute: true,
    });

    return result;
  }

  /**
   * Caches discovered workflow entries by input array reference.
   * Uses WeakMap to allow garbage collection when input arrays are no longer referenced.
   * This cache is invalidated automatically when the inputs array reference changes
   * (e.g., when files are added/removed during watch mode).
   */
  private discoveredEntries: WeakMap<
    string[],
    {
      discoveredSteps: string[];
      discoveredWorkflows: string[];
    }
  > = new WeakMap();

  protected async discoverEntries(
    inputs: string[],
    outdir: string
  ): Promise<{
    discoveredSteps: string[];
    discoveredWorkflows: string[];
  }> {
    const previousResult = this.discoveredEntries.get(inputs);

    if (previousResult) {
      return previousResult;
    }
    const state: {
      discoveredSteps: string[];
      discoveredWorkflows: string[];
    } = {
      discoveredSteps: [],
      discoveredWorkflows: [],
    };

    const discoverStart = Date.now();
    try {
      await esbuild.build({
        treeShaking: true,
        entryPoints: inputs,
        plugins: [createDiscoverEntriesPlugin(state)],
        platform: 'node',
        write: false,
        outdir,
        bundle: true,
        sourcemap: EMIT_SOURCEMAPS_FOR_DEBUGGING,
        absWorkingDir: this.config.workingDir,
        logLevel: 'silent',
      });
    } catch (_) {}

    console.log(
      `Discovering workflow directives`,
      `${Date.now() - discoverStart}ms`
    );

    this.discoveredEntries.set(inputs, state);
    return state;
  }

  /**
   * Writes debug information to a JSON file for troubleshooting build issues.
   * Uses atomic write (temp file + rename) to prevent race conditions when
   * multiple builds run concurrently.
   */
  private async writeDebugFile(
    outfile: string,
    debugData: object,
    merge?: boolean
  ): Promise<void> {
    const prefix = this.config.debugFilePrefix || '';
    const targetPath = `${dirname(outfile)}/${prefix}${basename(outfile)}.debug.json`;
    let existing = {};

    try {
      if (merge) {
        try {
          const content = await readFile(targetPath, 'utf8');
          existing = JSON.parse(content);
        } catch (e) {
          // File doesn't exist yet or is corrupted - start fresh.
          // Don't log error for ENOENT (file not found) as that's expected on first run.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('Error reading debug file, starting fresh:', e);
          }
        }
      }

      const mergedData = JSON.stringify(
        {
          ...existing,
          ...debugData,
        },
        null,
        2
      );

      // Write atomically: write to temp file, then rename.
      // rename() is atomic on POSIX systems and provides best-effort atomicity on Windows.
      // Prevents race conditions where concurrent builds read partially-written files.
      const tempPath = `${targetPath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, mergedData);
      await rename(tempPath, targetPath);
    } catch (error: unknown) {
      console.warn('Failed to write debug file:', error);
    }
  }

  /**
   * Logs and optionally throws on esbuild errors and warnings.
   * @param throwOnError - If true, throws an error when esbuild errors are present
   */
  private logEsbuildMessages(
    result: { errors?: any[]; warnings?: any[] },
    phase: string,
    throwOnError = true
  ): void {
    if (result.errors && result.errors.length > 0) {
      console.error(`❌ esbuild errors in ${phase}:`);
      const errorMessages: string[] = [];
      for (const error of result.errors) {
        console.error(`  ${error.text}`);
        errorMessages.push(error.text);
        if (error.location) {
          const location = `    at ${error.location.file}:${error.location.line}:${error.location.column}`;
          console.error(location);
          errorMessages.push(location);
        }
      }

      if (throwOnError) {
        throw new Error(
          `Build failed during ${phase}:\n${errorMessages.join('\n')}`
        );
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      console.warn(`!  esbuild warnings in ${phase}:`);
      for (const warning of result.warnings) {
        console.warn(`  ${warning.text}`);
        if (warning.location) {
          console.warn(
            `    at ${warning.location.file}:${warning.location.line}:${warning.location.column}`
          );
        }
      }
    }
  }

  /**
   * Creates a bundle for workflow step functions.
   * Steps have full Node.js runtime access and handle side effects, API calls, etc.
   *
   * @param externalizeNonSteps - If true, only bundles step entry points and externalizes other code
   */
  protected async createStepsBundle({
    inputFiles,
    format = 'cjs',
    outfile,
    externalizeNonSteps,
    tsBaseUrl,
    tsPaths,
  }: {
    tsPaths?: Record<string, string[]>;
    tsBaseUrl?: string;
    inputFiles: string[];
    outfile: string;
    format?: 'cjs' | 'esm';
    externalizeNonSteps?: boolean;
  }): Promise<esbuild.BuildContext | undefined> {
    // These need to handle watching for dev to scan for
    // new entries and changes to existing ones
    const { discoveredSteps: stepFiles } = await this.discoverEntries(
      inputFiles,
      dirname(outfile)
    );

    // log the step files for debugging
    await this.writeDebugFile(outfile, { stepFiles });

    const stepsBundleStart = Date.now();
    const workflowManifest: WorkflowManifest = {};
    const builtInSteps = 'workflow/internal/builtins';

    const resolvedBuiltInSteps = await enhancedResolve(
      dirname(outfile),
      'workflow/internal/builtins'
    ).catch((err) => {
      throw new Error(
        [
          chalk.red('Failed to resolve built-in steps sources.'),
          `${chalk.yellow.bold('hint:')} run \`${chalk.cyan.italic('npm install workflow')}\` to resolve this issue.`,
          '',
          `Caused by: ${chalk.red(String(err))}`,
        ].join('\n')
      );
    });

    // Create a virtual entry that imports all files. All step definitions
    // will get registered thanks to the swc transform.
    const imports = stepFiles
      .map((file) => {
        // Normalize both paths to forward slashes before calling relative()
        // This is critical on Windows where relative() can produce unexpected results with mixed path formats
        const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
        const normalizedFile = file.replace(/\\/g, '/');
        // Calculate relative path from working directory to the file
        let relativePath = relative(
          normalizedWorkingDir,
          normalizedFile
        ).replace(/\\/g, '/');
        // Ensure relative paths start with ./ so esbuild resolves them correctly
        if (!relativePath.startsWith('.')) {
          relativePath = `./${relativePath}`;
        }
        return `import '${relativePath}';`;
      })
      .join('\n');

    const entryContent = `
    // Built in steps
    import '${builtInSteps}';
    // User steps
    ${imports}
    // API entrypoint
    export { stepEntrypoint as POST } from 'workflow/runtime';`;

    // Bundle with esbuild and our custom SWC plugin
    const esbuildCtx = await esbuild.context({
      banner: {
        js: '// biome-ignore-all lint: generated file\n/* eslint-disable */\n',
      },
      stdin: {
        contents: entryContent,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      outfile,
      absWorkingDir: this.config.workingDir,
      bundle: true,
      format,
      platform: 'node',
      conditions: ['node'],
      target: 'es2022',
      write: true,
      treeShaking: true,
      keepNames: true,
      minify: false,
      jsx: 'preserve',
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      // TODO: investigate proper source map support
      sourcemap: EMIT_SOURCEMAPS_FOR_DEBUGGING,
      plugins: [
        createSwcPlugin({
          mode: 'step',
          entriesToBundle: externalizeNonSteps
            ? [
                ...stepFiles,
                ...(resolvedBuiltInSteps ? [resolvedBuiltInSteps] : []),
              ]
            : undefined,
          outdir: outfile ? dirname(outfile) : undefined,
          tsBaseUrl,
          tsPaths,
          workflowManifest,
        }),
      ],
      // Plugin should catch most things, but this lets users hard override
      // if the plugin misses anything that should be externalized
      external: ['bun', 'bun:*', ...(this.config.externalPackages || [])],
    });

    const stepsResult = await esbuildCtx.rebuild();

    this.logEsbuildMessages(stepsResult, 'steps bundle creation');
    console.log('Created steps bundle', `${Date.now() - stepsBundleStart}ms`);

    const partialWorkflowManifest = {
      steps: workflowManifest.steps,
    };
    // always write to debug file
    await this.writeDebugFile(
      join(dirname(outfile), 'manifest'),
      partialWorkflowManifest,
      true
    );

    // Create .gitignore in .swc directory
    await this.createSwcGitignore();

    if (this.config.watch) {
      return esbuildCtx;
    }
    await esbuildCtx.dispose();
  }

  /**
   * Creates a bundle for workflow orchestration functions.
   * Workflows run in a sandboxed VM and coordinate step execution.
   *
   * @param bundleFinalOutput - If false, skips the final bundling step (used by Next.js)
   */
  protected async createWorkflowsBundle({
    inputFiles,
    format = 'cjs',
    outfile,
    bundleFinalOutput = true,
    tsBaseUrl,
    tsPaths,
  }: {
    tsPaths?: Record<string, string[]>;
    tsBaseUrl?: string;
    inputFiles: string[];
    outfile: string;
    format?: 'cjs' | 'esm';
    bundleFinalOutput?: boolean;
  }): Promise<void | {
    interimBundleCtx: esbuild.BuildContext;
    bundleFinal: (interimBundleResult: string) => Promise<void>;
  }> {
    const { discoveredWorkflows: workflowFiles } = await this.discoverEntries(
      inputFiles,
      dirname(outfile)
    );

    // log the workflow files for debugging
    await this.writeDebugFile(outfile, { workflowFiles });

    // Create a virtual entry that imports all workflow files
    // The SWC plugin in workflow mode emits `globalThis.__private_workflows.set(workflowId, fn)`
    // calls directly, so we just need to import the files (Map is initialized via banner)
    const imports = workflowFiles
      .map((file) => {
        // Normalize both paths to forward slashes before calling relative()
        // This is critical on Windows where relative() can produce unexpected results with mixed path formats
        const normalizedWorkingDir = this.config.workingDir.replace(/\\/g, '/');
        const normalizedFile = file.replace(/\\/g, '/');
        // Calculate relative path from working directory to the file
        let relativePath = relative(
          normalizedWorkingDir,
          normalizedFile
        ).replace(/\\/g, '/');
        // Ensure relative paths start with ./ so esbuild resolves them correctly
        if (!relativePath.startsWith('.')) {
          relativePath = `./${relativePath}`;
        }
        return `import '${relativePath}';`;
      })
      .join('\n');

    const bundleStartTime = Date.now();
    const workflowManifest: WorkflowManifest = {};

    // Bundle with esbuild and our custom SWC plugin in workflow mode.
    // this bundle will be run inside a vm isolate
    const interimBundleCtx = await esbuild.context({
      stdin: {
        contents: imports,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      bundle: true,
      absWorkingDir: this.config.workingDir,
      format: 'cjs', // Runs inside the VM which expects cjs
      platform: 'neutral', // The platform is neither node nor browser
      mainFields: ['module', 'main'], // To support npm style imports
      conditions: ['workflow'], // Allow packages to export 'workflow' compliant versions
      target: 'es2022',
      write: false,
      treeShaking: true,
      keepNames: true,
      minify: false,
      // Initialize the workflow registry at the very top of the bundle
      // This must be in banner (not the virtual entry) because esbuild's bundling
      // can reorder code, and the .set() calls need the Map to exist first
      banner: {
        js: 'globalThis.__private_workflows = new Map();',
      },
      // Inline source maps for better stack traces in workflow VM execution.
      // This intermediate bundle is executed via runInContext() in a VM, so we need
      // inline source maps to get meaningful stack traces instead of "evalmachine.<anonymous>".
      sourcemap: 'inline',
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          tsBaseUrl,
          tsPaths,
          workflowManifest,
        }),
        // This plugin must run after the swc plugin to ensure dead code elimination
        // happens first, preventing false positives on Node.js imports in unused code paths
        createNodeModuleErrorPlugin(),
      ],
    });
    const interimBundle = await interimBundleCtx.rebuild();

    this.logEsbuildMessages(interimBundle, 'intermediate workflow bundle');
    console.log(
      'Created intermediate workflow bundle',
      `${Date.now() - bundleStartTime}ms`
    );

    const partialWorkflowManifest = {
      workflows: workflowManifest.workflows,
    };

    await this.writeDebugFile(
      join(dirname(outfile), 'manifest'),
      partialWorkflowManifest,
      true
    );

    if (this.config.workflowManifestPath) {
      const resolvedPath = resolve(
        process.cwd(),
        this.config.workflowManifestPath
      );
      let prefix = '';

      if (resolvedPath.endsWith('.cjs')) {
        prefix = 'module.exports = ';
      } else if (
        resolvedPath.endsWith('.js') ||
        resolvedPath.endsWith('.mjs')
      ) {
        prefix = 'export default ';
      }

      await mkdir(dirname(resolvedPath), { recursive: true });
      await writeFile(
        resolvedPath,
        prefix + JSON.stringify(workflowManifest.workflows, null, 2)
      );
    }

    // Create .gitignore in .swc directory
    await this.createSwcGitignore();

    if (!interimBundle.outputFiles || interimBundle.outputFiles.length === 0) {
      throw new Error('No output files generated from esbuild');
    }

    const bundleFinal = async (interimBundle: string) => {
      const workflowBundleCode = interimBundle;

      const workflowFunctionCode = `// biome-ignore-all lint: generated file
/* eslint-disable */
import { workflowEntrypoint } from 'workflow/runtime';

const workflowCode = \`${workflowBundleCode.replace(/[\\`$]/g, '\\$&')}\`;

export const POST = workflowEntrypoint(workflowCode);`;

      // we skip the final bundling step for Next.js so it can bundle itself
      if (!bundleFinalOutput) {
        if (!outfile) {
          throw new Error(`Invariant: missing outfile for workflow bundle`);
        }
        // Ensure the output directory exists
        const outputDir = dirname(outfile);
        await mkdir(outputDir, { recursive: true });

        // Atomic write: write to temp file then rename to prevent
        // file watchers from reading partial file during write
        const tempPath = `${outfile}.${randomUUID()}.tmp`;
        await writeFile(tempPath, workflowFunctionCode);
        await rename(tempPath, outfile);
        return;
      }

      const bundleStartTime = Date.now();

      // Now bundle this so we can resolve the @workflow/core dependency
      // we could remove this if we do nft tracing or similar instead
      const finalWorkflowResult = await esbuild.build({
        banner: {
          js: '// biome-ignore-all lint: generated file\n/* eslint-disable */\n',
        },
        stdin: {
          contents: workflowFunctionCode,
          resolveDir: this.config.workingDir,
          sourcefile: 'virtual-entry.js',
          loader: 'js',
        },
        outfile,
        // Source maps for the final workflow bundle wrapper (not important since this code
        // doesn't run in the VM - only the intermediate bundle sourcemap is relevant)
        sourcemap: EMIT_SOURCEMAPS_FOR_DEBUGGING,
        absWorkingDir: this.config.workingDir,
        bundle: true,
        format,
        platform: 'node',
        target: 'es2022',
        write: true,
        keepNames: true,
        minify: false,
        external: ['@aws-sdk/credential-provider-web-identity'],
      });

      this.logEsbuildMessages(finalWorkflowResult, 'final workflow bundle');
      console.log(
        'Created final workflow bundle',
        `${Date.now() - bundleStartTime}ms`
      );
    };
    await bundleFinal(interimBundle.outputFiles[0].text);

    if (this.config.watch) {
      return {
        interimBundleCtx,
        bundleFinal,
      };
    }
    await interimBundleCtx.dispose();
  }

  /**
   * Creates a client library bundle for workflow execution.
   * The client library allows importing and calling workflows from application code.
   * Only generated if clientBundlePath is specified in config.
   */
  protected async createClientLibrary(): Promise<void> {
    if (!this.config.clientBundlePath) {
      // Silently exit since no client bundle was requested
      return;
    }

    console.log('Generating a client library at', this.config.clientBundlePath);
    console.log(
      'NOTE: The recommended way to use workflow with a framework like NextJS is using the loader/plugin with webpack/turbobpack/rollup'
    );

    // Ensure we have the directory for the client bundle
    const outputDir = dirname(this.config.clientBundlePath);
    await mkdir(outputDir, { recursive: true });

    const inputFiles = await this.getInputFiles();

    // Create a virtual entry that imports all files
    const imports = inputFiles
      .map((file) => `export * from '${file}';`)
      .join('\n');

    // Bundle with esbuild and our custom SWC plugin
    const clientResult = await esbuild.build({
      banner: {
        js: '// biome-ignore-all lint: generated file\n/* eslint-disable */\n',
      },
      stdin: {
        contents: imports,
        resolveDir: this.config.workingDir,
        sourcefile: 'virtual-entry.js',
        loader: 'js',
      },
      outfile: this.config.clientBundlePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'preserve',
      target: 'es2022',
      write: true,
      treeShaking: true,
      external: ['@workflow/core'],
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      plugins: [createSwcPlugin({ mode: 'client' })],
    });

    this.logEsbuildMessages(clientResult, 'client library bundle');

    // Create .gitignore in .swc directory
    await this.createSwcGitignore();
  }

  /**
   * Creates a webhook handler bundle for resuming workflows via HTTP callbacks.
   *
   * @param bundle - If true, bundles dependencies (needed for Build Output API)
   */
  protected async createWebhookBundle({
    outfile,
    bundle = false,
  }: {
    outfile: string;
    bundle?: boolean;
  }): Promise<void> {
    console.log('Creating webhook route');
    await mkdir(dirname(outfile), { recursive: true });

    // Create a static route that calls resumeWebhook
    // This route works for both Next.js and Vercel Build Output API
    const routeContent = `import { resumeWebhook } from 'workflow/api';

async function handler(request) {
  const url = new URL(request.url);
  // Extract token from pathname: /.well-known/workflow/v1/webhook/{token}
  const pathParts = url.pathname.split('/');
  const token = decodeURIComponent(pathParts[pathParts.length - 1]);

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const response = await resumeWebhook(token, request);
    return response;
  } catch (error) {
    // TODO: differentiate between invalid token and other errors
    console.error('Error during resumeWebhook', error);
    return new Response(null, { status: 404 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;`;

    if (!bundle) {
      // For Next.js, just write the unbundled file
      await writeFile(outfile, routeContent);
      return;
    }

    // For Build Output API, bundle with esbuild to resolve imports

    const webhookBundleStart = Date.now();
    const result = await esbuild.build({
      banner: {
        js: `// biome-ignore-all lint: generated file\n/* eslint-disable */`,
      },
      stdin: {
        contents: routeContent,
        resolveDir: this.config.workingDir,
        sourcefile: 'webhook-route.js',
        loader: 'js',
      },
      outfile,
      absWorkingDir: this.config.workingDir,
      bundle: true,
      jsx: 'preserve',
      format: 'cjs',
      platform: 'node',
      conditions: ['import', 'module', 'node', 'default'],
      target: 'es2022',
      write: true,
      treeShaking: true,
      keepNames: true,
      minify: false,
      resolveExtensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
      ],
      sourcemap: false,
      mainFields: ['module', 'main'],
      // Don't externalize anything - bundle everything including workflow packages
      external: [],
    });

    this.logEsbuildMessages(result, 'webhook bundle creation');
    console.log(
      'Created webhook bundle',
      `${Date.now() - webhookBundleStart}ms`
    );
  }

  /**
   * Creates a package.json file with the specified module type.
   */
  protected async createPackageJson(
    dir: string,
    type: 'commonjs' | 'module'
  ): Promise<void> {
    const packageJson = { type };
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  }

  /**
   * Creates a .vc-config.json file for Vercel Build Output API functions.
   */
  protected async createVcConfig(
    dir: string,
    config: {
      runtime?: string;
      handler?: string;
      launcherType?: string;
      architecture?: string;
      shouldAddHelpers?: boolean;
      shouldAddSourcemapSupport?: boolean;
      experimentalTriggers?: Array<{
        type: string;
        topic: string;
        consumer: string;
        maxDeliveries?: number;
        retryAfterSeconds?: number;
        initialDelaySeconds?: number;
      }>;
    }
  ): Promise<void> {
    const vcConfig = {
      runtime: config.runtime ?? 'nodejs22.x',
      handler: config.handler ?? 'index.js',
      launcherType: config.launcherType ?? 'Nodejs',
      architecture: config.architecture ?? 'arm64',
      shouldAddHelpers: config.shouldAddHelpers ?? true,
      ...(config.shouldAddSourcemapSupport !== undefined && {
        shouldAddSourcemapSupport: config.shouldAddSourcemapSupport,
      }),
      ...(config.experimentalTriggers && {
        experimentalTriggers: config.experimentalTriggers,
      }),
    };

    await writeFile(
      join(dir, '.vc-config.json'),
      JSON.stringify(vcConfig, null, 2)
    );
  }

  /**
   * Resolves a path relative to the working directory.
   */
  protected resolvePath(path: string): string {
    return resolve(this.config.workingDir, path);
  }

  /**
   * Ensures the directory for a file path exists, creating it if necessary.
   */
  protected async ensureDirectory(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  private async createSwcGitignore(): Promise<void> {
    try {
      await writeFile(
        join(this.config.workingDir, '.swc', '.gitignore'),
        '*\n'
      );
    } catch {
      // We're intentionally silently ignoring this error - creating .gitignore isn't critical
    }
  }
}
