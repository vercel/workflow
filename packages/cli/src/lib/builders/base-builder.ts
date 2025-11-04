import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { parse } from 'comment-json';
import enhancedResolveOriginal from 'enhanced-resolve';
import * as esbuild from 'esbuild';
import { findUp } from 'find-up';
import { glob } from 'tinyglobby';
import type { WorkflowConfig } from '../config/types.js';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { createDiscoverEntriesPlugin } from './discover-entries-esbuild-plugin.js';
import { createNodeModuleErrorPlugin } from './node-module-esbuild-plugin.js';
import { createSwcPlugin } from './swc-esbuild-plugin.js';

const enhancedResolve = promisify(enhancedResolveOriginal);

const EMIT_SOURCEMAPS_FOR_DEBUGGING =
  process.env.WORKFLOW_EMIT_SOURCEMAPS_FOR_DEBUGGING === '1';

export abstract class BaseBuilder {
  protected config: WorkflowConfig;

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  abstract build(): Promise<void>;

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

  protected async getInputFiles(): Promise<string[]> {
    console.log('[DEBUG] Config dirs:', this.config.dirs);
    console.log('[DEBUG] Working dir:', this.config.workingDir);

    const patterns = this.config.dirs.map((dir) => {
      const resolvedDir = resolve(this.config.workingDir, dir);
      // Normalize path separators to forward slashes for glob compatibility
      const normalizedDir = resolvedDir.replace(/\\/g, '/');
      console.log(`[DEBUG] Dir "${dir}" resolved to: ${normalizedDir}`);
      return `${normalizedDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
    });

    console.log('[DEBUG] Glob patterns:', patterns);

    const result = await glob(patterns, {
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.next/**',
        '**/.vercel/**',
        '**/.workflow-data/**',
        '**/.well-known/workflow/**',
      ],
      absolute: true,
    });

    console.log(`[DEBUG] Glob matched ${result.length} files`);
    if (result.length > 0) {
      console.log('[DEBUG] First few matches:', result.slice(0, 3));
    }

    return result;
  }

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

  // write debug information to JSON file (maybe move to diagnostics folder)
  // if on Vercel
  private async writeDebugFile(
    outfile: string,
    debugData: object,
    merge?: boolean
  ): Promise<void> {
    try {
      let existing = {};
      if (merge) {
        existing = JSON.parse(
          await readFile(`${outfile}.debug.json`, 'utf8').catch(() => '{}')
        );
      }
      const finalData = {
        ...existing,
        ...debugData,
      };

      // Sanity check for manifest files
      if (outfile.includes('manifest')) {
        const workflowCount = Object.keys(
          (finalData as any).workflows || {}
        ).length;
        const stepCount = Object.keys((finalData as any).steps || {}).length;
        console.log(
          `ℹ️  Manifest file: workflows=${workflowCount}, steps=${stepCount}`
        );
        if (workflowCount === 0 && stepCount === 0) {
          console.warn(`⚠️  Warning: manifest is empty!`);
        }
      }

      await writeFile(
        `${outfile}.debug.json`,
        JSON.stringify(finalData, null, 2)
      );
    } catch (error: unknown) {
      console.warn('Failed to write debug file:', error);
    }
  }

  private logEsbuildMessages(
    result: { errors?: any[]; warnings?: any[] },
    phase: string
  ): void {
    if (result.errors && result.errors.length > 0) {
      console.error(`❌ esbuild errors in ${phase}:`);
      for (const error of result.errors) {
        console.error(`  ${error.text}`);
        if (error.location) {
          console.error(
            `    at ${error.location.file}:${error.location.line}:${error.location.column}`
          );
        }
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
        // Normalize path separators to forward slashes for cross-platform compatibility
        const normalizedPath = file.replace(/\\/g, '/');
        return `import '${normalizedPath}';`;
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
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
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
      external: this.config.externalPackages || [],
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

    console.log(
      `[DEBUG] Discovered workflow files (${workflowFiles.length}):`,
      workflowFiles.map((f) => f.replace(this.config.workingDir, '.'))
    );

    // Create a virtual entry that imports all files
    const imports =
      `globalThis.__private_workflows = new Map();\n` +
      workflowFiles
        .map((file, workflowFileIdx) => {
          // Normalize path separators to forward slashes for cross-platform compatibility
          // This is critical for Windows where paths contain backslashes
          const normalizedPath = file.replace(/\\/g, '/');
          return `import * as workflowFile${workflowFileIdx} from '${normalizedPath}';
            Object.values(workflowFile${workflowFileIdx}).map(item => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item))`;
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
      // TODO: investigate proper source map support
      sourcemap: EMIT_SOURCEMAPS_FOR_DEBUGGING,
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
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

    const workflowCount = Object.keys(workflowManifest.workflows || {}).length;
    console.log(
      `[DEBUG] Manifest has ${workflowCount} workflow entries from ${Object.keys(workflowManifest.workflows || {}).length} files`
    );
    console.log(
      `[DEBUG] Workflow files in manifest:`,
      Object.keys(workflowManifest.workflows || {})
    );

    const partialWorkflowManifest = {
      workflows: workflowManifest.workflows,
    };
    console.log(
      `DEBUG: Writing workflow manifest with ${workflowCount} workflows`
    );
    // Write additional debug info to a dedicated file for easier debugging
    const debugDir = dirname(outfile);
    const debugFileName = join(debugDir, '.workflow-manifest-debug.json');
    try {
      const debugInfo = {
        timestamp: new Date().toISOString(),
        workflowCount,
        discoveredWorkflowFiles: workflowFiles,
        manifestWorkflowFiles: Object.keys(workflowManifest.workflows || {}),
        workflows: Object.keys(workflowManifest.workflows || {}),
        manifestFile: join(dirname(outfile), 'manifest.debug.json'),
        outfile,
      };
      await writeFile(debugFileName, JSON.stringify(debugInfo, null, 2));
    } catch (error) {
      console.warn('Failed to write workflow manifest debug file:', error);
    }

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

      // Create the workflow function handler with proper linter suppressions
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

        await writeFile(outfile, workflowFunctionCode);
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
        // TODO: investigate proper source map support
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

  protected async buildClientLibrary(): Promise<void> {
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
      target: 'es2022',
      write: true,
      treeShaking: true,
      external: ['@workflow/core'],
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      plugins: [createSwcPlugin({ mode: 'client' })],
    });

    this.logEsbuildMessages(clientResult, 'client library bundle');

    // Create .gitignore in .swc directory
    await this.createSwcGitignore();
  }

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
export const OPTIONS = handler;
`;

    if (!bundle) {
      // For Next.js, just write the unbundled file
      await writeFile(outfile, routeContent);
      return;
    }

    // For Build Output API, bundle with esbuild to resolve imports

    const webhookBundleStart = Date.now();
    const result = await esbuild.build({
      banner: {
        js: '// biome-ignore-all lint: generated file\n/* eslint-disable */\n',
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
      format: 'cjs',
      platform: 'node',
      conditions: ['import', 'module', 'node', 'default'],
      target: 'es2022',
      write: true,
      treeShaking: true,
      keepNames: true,
      minify: false,
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
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
