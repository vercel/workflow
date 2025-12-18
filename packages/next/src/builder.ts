import { constants, unlinkSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { NextConfig } from 'next';

let CachedNextBuilder: any;

// Create the NextBuilder class dynamically by extending the ESM BaseBuilder
// This is exported as getNextBuilder() to allow CommonJS modules to import
// from the ESM @workflow/builders package via dynamic import at runtime
export async function getNextBuilder() {
  if (CachedNextBuilder) {
    return CachedNextBuilder;
  }

  const {
    BaseBuilder: BaseBuilderClass,
    STEP_QUEUE_TRIGGER,
    WORKFLOW_QUEUE_TRIGGER,
  } = await import('@workflow/builders');

  class NextBuilder extends BaseBuilderClass {
    private socketIO?: any;
    private nextConfig?: NextConfig;

    setNextConfig(config: NextConfig) {
      this.nextConfig = config;
    }

    private getDistDir(): string {
      return this.nextConfig?.distDir || '.next';
    }

    private async writeWorkflowsCache(
      workflowFiles: Set<string>,
      stepFiles: Set<string>
    ) {
      const cwd = this.config.workingDir;
      const distDir = this.getDistDir();
      const cacheDir = join(cwd, distDir, 'cache');
      const cacheFile = join(cacheDir, 'workflows.json');

      try {
        await mkdir(cacheDir, { recursive: true });
        const cacheData = {
          workflowFiles: Array.from(workflowFiles),
          stepFiles: Array.from(stepFiles),
          timestamp: Date.now(),
        };
        await writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
      } catch (error) {
        console.error('Failed to write workflows cache:', error);
      }
    }

    private async readWorkflowsCache(): Promise<{
      workflowFiles: string[];
      stepFiles: string[];
    } | null> {
      const cwd = this.config.workingDir;
      const distDir = this.getDistDir();
      const cacheFile = join(cwd, distDir, 'cache', 'workflows.json');

      try {
        const cacheContent = await readFile(cacheFile, 'utf-8');
        const cacheData = JSON.parse(cacheContent);
        return {
          workflowFiles: cacheData.workflowFiles || [],
          stepFiles: cacheData.stepFiles || [],
        };
      } catch {
        // Cache file doesn't exist or is invalid, return null
        return null;
      }
    }

    async init() {
      const outputDir = await this.findAppDirectory();

      // Write stub files
      await this.writeStubFiles(outputDir);

      // Create socket server for file path communication
      await this.createSocketServer(outputDir);
    }

    async build(inputFiles?: string[]) {
      const outputDir = await this.findAppDirectory();
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });
      // ignore the generated assets

      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');

      // Use provided inputFiles or discover them
      const files = inputFiles || (await this.getInputFiles());
      const tsConfig = await this.getTsConfigOptions();

      const options = {
        inputFiles: files,
        workflowGeneratedDir,
        tsBaseUrl: tsConfig.baseUrl,
        tsPaths: tsConfig.paths,
      };

      await this.buildStepsFunction(options);
      await this.buildWorkflowsFunction(options);
      await this.buildWebhookRoute({ workflowGeneratedDir });
      await this.writeFunctionsConfig(outputDir);

      // Signal build complete to connected clients
      if (this.socketIO) {
        this.socketIO.emit('build-complete');
      }
    }

    protected async getInputFiles(): Promise<string[]> {
      const inputFiles = await super.getInputFiles();
      return inputFiles.filter((item) =>
        // non-exact pattern match to try to narrow
        // down to just app route entrypoints, this will
        // not be valid when pages router support is added
        item.match(/[/\\](route|page|layout)\./)
      );
    }

    private async writeFunctionsConfig(outputDir: string) {
      // we don't run this in development mode as it's not needed
      if (process.env.NODE_ENV === 'development') {
        return;
      }
      const generatedConfig = {
        version: '0',
        steps: {
          experimentalTriggers: [STEP_QUEUE_TRIGGER],
        },
        workflows: {
          experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
        },
      };

      // We write this file to the generated directory for
      // the Next.js builder to consume
      await writeFile(
        join(outputDir, '.well-known/workflow/v1/config.json'),
        JSON.stringify(generatedConfig, null, 2)
      );
    }

    private async buildStepsFunction({
      inputFiles,
      workflowGeneratedDir,
      tsPaths,
      tsBaseUrl,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsBaseUrl?: string;
      tsPaths?: Record<string, string[]>;
    }) {
      // Create steps bundle
      const stepsRouteDir = join(workflowGeneratedDir, 'step');
      await mkdir(stepsRouteDir, { recursive: true });
      return await this.createStepsBundle({
        // If any dynamic requires are used when bundling with ESM
        // esbuild will create a too dynamic wrapper around require
        // which turbopack/webpack fail to analyze. If we externalize
        // correctly this shouldn't be an issue although we might want
        // to use cjs as alternative to avoid
        format: 'esm',
        inputFiles,
        outfile: join(stepsRouteDir, 'route.js'),
        externalizeNonSteps: true,
        tsBaseUrl,
        tsPaths,
      });
    }

    private async buildWorkflowsFunction({
      inputFiles,
      workflowGeneratedDir,
      tsPaths,
      tsBaseUrl,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsBaseUrl?: string;
      tsPaths?: Record<string, string[]>;
    }): Promise<void | {
      interimBundleCtx: import('esbuild').BuildContext;
      bundleFinal: (interimBundleResult: string) => Promise<void>;
    }> {
      const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
      await mkdir(workflowsRouteDir, { recursive: true });
      return await this.createWorkflowsBundle({
        format: 'esm',
        outfile: join(workflowsRouteDir, 'route.js'),
        bundleFinalOutput: false,
        inputFiles,
        tsBaseUrl,
        tsPaths,
      });
    }

    private async buildWebhookRoute({
      workflowGeneratedDir,
    }: {
      workflowGeneratedDir: string;
    }): Promise<void> {
      const webhookRouteFile = join(
        workflowGeneratedDir,
        'webhook/[token]/route.js'
      );
      await this.createWebhookBundle({
        outfile: webhookRouteFile,
        bundle: false, // Next.js doesn't need bundling
      });
    }

    private async findAppDirectory(): Promise<string> {
      const appDir = resolve(this.config.workingDir, 'app');
      const srcAppDir = resolve(this.config.workingDir, 'src/app');

      try {
        await access(appDir, constants.F_OK);
        const appStats = await stat(appDir);
        if (!appStats.isDirectory()) {
          throw new Error(`Path exists but is not a directory: ${appDir}`);
        }
        return appDir;
      } catch {
        try {
          await access(srcAppDir, constants.F_OK);
          const srcAppStats = await stat(srcAppDir);
          if (!srcAppStats.isDirectory()) {
            throw new Error(`Path exists but is not a directory: ${srcAppDir}`);
          }
          return srcAppDir;
        } catch {
          throw new Error(
            'Could not find Next.js app directory. Expected either "app" or "src/app" to exist.'
          );
        }
      }
    }

    private async createSocketServer(_usersAppDir: string): Promise<void> {
      if (process.env.WORKFLOW_SOCKET_PATH) {
        return;
      }
      const { createServer } = await import('node:net');
      const { unlink } = await import('node:fs/promises');

      const workflowFiles = new Set<string>();
      const stepFiles = new Set<string>();
      const clients = new Set<any>();
      let debounceTimer: NodeJS.Timeout | null = null;

      const BUILD_DEBOUNCE_MS =
        process.env.NODE_ENV === 'development' ? 250 : 1_000;

      // Attempt to load cached workflows/steps from previous build
      const cache = await this.readWorkflowsCache();
      if (cache) {
        for (const file of cache.workflowFiles) {
          workflowFiles.add(file);
        }
        for (const file of cache.stepFiles) {
          stepFiles.add(file);
        }
      }

      // Debounced build trigger
      const triggerBuild = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(async () => {
          // Combine workflow and step files into single array
          const allFiles = new Set([...workflowFiles, ...stepFiles]);
          const inputFiles = Array.from(allFiles);

          if (inputFiles.length > 0) {
            console.log(
              `Triggering build with ${inputFiles.length} discovered files`
            );
            try {
              await this.build(inputFiles);
              // Write cache after successful build
              await this.writeWorkflowsCache(workflowFiles, stepFiles);
            } catch (error) {
              console.error('Build failed:', error);
            }
          }
          debounceTimer = null;
        }, BUILD_DEBOUNCE_MS);
      };

      // Generate socket path in distDir
      const cwd = this.config.workingDir;
      const distDir = this.getDistDir();
      const socketDir = join(cwd, distDir, 'cache');
      await mkdir(socketDir, { recursive: true });
      const socketPath = join(
        socketDir,
        `workflow-${process.pid}-${Date.now()}.sock`
      );

      process.on('exit', () => {
        try {
          unlinkSync(socketPath);
        } catch {}
      });

      // Create Unix domain socket server
      const server = createServer((socket) => {
        clients.add(socket);

        let buffer = '';

        socket.on('data', (data) => {
          buffer += data.toString();

          // Process complete messages (newline-delimited JSON)
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');

            if (line.trim()) {
              try {
                const message = JSON.parse(line);

                if (message.type === 'file-discovered') {
                  const { filePath, hasWorkflow, hasStep } = message;

                  if (hasWorkflow) {
                    workflowFiles.add(filePath);
                  }

                  if (hasStep) {
                    stepFiles.add(filePath);
                  }

                  // Trigger debounced build
                  triggerBuild();
                } else if (message.type === 'trigger-build') {
                  // enqueue new build if one isn't already pending
                  if (!debounceTimer) {
                    triggerBuild();
                  }
                }
              } catch (error) {
                console.error('Failed to parse socket message:', error);
              }
            }
          }
        });

        socket.on('end', () => {
          clients.delete(socket);
        });

        socket.on('error', (err) => {
          console.error('Socket error:', err);
          clients.delete(socket);
        });
      });

      // Clean up existing socket file if it exists
      try {
        await unlink(socketPath);
      } catch {
        // Ignore error if file doesn't exist
      }

      // Listen on Unix domain socket
      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => {
          // Expose the socket path via environment variable
          process.env.WORKFLOW_SOCKET_PATH = socketPath;
          resolve();
        });
      });

      // Store the server and broadcast function
      this.socketIO = {
        emit: (event: string) => {
          if (event === 'build-complete') {
            const message = JSON.stringify({ type: 'build-complete' }) + '\n';
            for (const client of clients) {
              client.write(message);
            }
          }
        },
      };
    }

    private async writeStubFiles(usersAppDir: string): Promise<void> {
      const routeStubContent =
        "import 'workflow'\n" + "export * from './inner'";
      // this needs to change on each build so can refresh workflows
      const innerStubContent = 'WORKFLOW_INNER_STUB_FILE_' + Date.now();
      const workflowDir = join(usersAppDir, '.well-known/workflow/v1');

      // Ensure directories exist
      await mkdir(join(workflowDir, 'flow'), { recursive: true });
      await mkdir(join(workflowDir, 'step'), { recursive: true });
      await mkdir(join(workflowDir, 'webhook'), { recursive: true });
      await mkdir(join(workflowDir, 'webhook/[token]'), { recursive: true });

      // Write route.ts stub files (re-export from inner)
      await writeFile(join(workflowDir, 'flow/route.js'), routeStubContent);
      await writeFile(join(workflowDir, 'step/route.js'), routeStubContent);
      await writeFile(join(workflowDir, 'webhook/route.js'), routeStubContent);
      await writeFile(
        join(workflowDir, 'webhook/[token]/route.js'),
        routeStubContent
      );

      // Write inner.js stub files (actual stub marker)
      await writeFile(join(workflowDir, 'flow/inner.js'), innerStubContent);
      await writeFile(join(workflowDir, 'step/inner.js'), innerStubContent);
      await writeFile(join(workflowDir, 'webhook/inner.js'), innerStubContent);
      await writeFile(
        join(workflowDir, 'webhook/[token]/inner.js'),
        innerStubContent
      );
    }
  }

  CachedNextBuilder = NextBuilder;
  return NextBuilder;
}
