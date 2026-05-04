import { constants } from 'node:fs';
import { access, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { WorkflowManifest } from '@workflow/builders';
import Watchpack from 'watchpack';

let CachedNextBuilderEager: any;

// Create the eager Next builder dynamically by extending the ESM BaseBuilder.
// Exported as getNextBuilderEager() to allow CommonJS modules to import from
// the ESM @workflow/builders package via dynamic import at runtime.
export async function getNextBuilderEager() {
  if (CachedNextBuilderEager) {
    return CachedNextBuilderEager;
  }

  const {
    BaseBuilder: BaseBuilderClass,
    WORKFLOW_QUEUE_TRIGGER,
    // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript from transpiling the import statement into `require()`
  } = (await eval(
    'import("@workflow/builders")'
  )) as typeof import('@workflow/builders');

  class NextBuilder extends BaseBuilderClass {
    async build() {
      const outputDir = await this.findAppDirectory();
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });
      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');

      const inputFiles = await this.getInputFiles();
      const tsconfigPath = await this.findTsConfigPath();

      const options = {
        inputFiles,
        workflowGeneratedDir,
        tsconfigPath,
      };

      // V2: Build combined route (replaces separate step + flow routes)
      const combinedResult = await this.buildCombinedFunction(options);
      await this.buildWebhookRoute({ workflowGeneratedDir });

      const writeManifest = async (
        sourceManifest: WorkflowManifest | undefined
      ) => {
        const manifest = {
          steps: { ...sourceManifest?.steps },
          workflows: { ...sourceManifest?.workflows },
          classes: { ...sourceManifest?.classes },
        };

        // Write manifest
        const workflowBundlePath = join(workflowGeneratedDir, 'flow/route.js');
        const manifestJson = await this.createManifest({
          workflowBundlePath,
          manifestDir: workflowGeneratedDir,
          manifest,
        });

        // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
        if (this.shouldExposePublicManifest && manifestJson) {
          const publicManifestDir = join(
            this.config.workingDir,
            'public/.well-known/workflow/v1'
          );
          await mkdir(publicManifestDir, { recursive: true });
          await copyFile(
            join(workflowGeneratedDir, 'manifest.json'),
            join(publicManifestDir, 'manifest.json')
          );
        }
      };

      await writeManifest(combinedResult?.manifest);

      await this.writeFunctionsConfig(outputDir);

      if (this.config.watch) {
        // TODO: implement watch mode for combined bundle
        // For now, fall back to full rebuild on file changes
        let stepsCtx = combinedResult?.stepsContext;
        if (!stepsCtx) {
          throw new Error(
            'Invariant: expected steps build context in watch mode'
          );
        }

        // Use stepsCtx for the watch rebuild (workflow interim ctx from combined)
        let workflowsCtx = {
          interimBundleCtx: combinedResult?.interimBundleCtx!,
          bundleFinal: combinedResult?.bundleFinal!,
        };

        const normalizePath = (pathname: string) =>
          pathname.replace(/\\/g, '/');
        const knownFiles = new Set<string>();
        type WatchpackTimeInfoEntry = {
          safeTime: number;
          timestamp?: number;
        };
        let previousTimeInfo = new Map<string, WatchpackTimeInfoEntry>();

        const watchableExtensions = new Set([
          '.js',
          '.jsx',
          '.ts',
          '.tsx',
          '.mts',
          '.cts',
          '.cjs',
          '.mjs',
        ]);
        const ignoredPathFragments = [
          '/.git/',
          '/node_modules/',
          '/.next/',
          '/.turbo/',
          '/.vercel/',
          '/dist/',
          '/build/',
          '/out/',
          '/.cache/',
          '/.yarn/',
          '/.pnpm-store/',
          '/.parcel-cache/',
          '/.well-known/workflow/',
        ];
        const normalizedGeneratedDir = workflowGeneratedDir.replace(/\\/g, '/');
        ignoredPathFragments.push(normalizedGeneratedDir);

        // There is a node.js bug on MacOS which causes closing file watchers to be really slow.
        // This limits the number of watchers to mitigate the issue.
        // https://github.com/nodejs/node/issues/29949
        process.env.WATCHPACK_WATCHER_LIMIT =
          process.platform === 'darwin' ? '20' : undefined;

        const watcher = new Watchpack({
          // Watchpack default is 200ms which adds 200ms of dead time on bootup.
          aggregateTimeout: 5,
          ignored: (pathname: string) => {
            const normalizedPath = pathname.replace(/\\/g, '/');
            const extension = extname(normalizedPath);
            if (extension && !watchableExtensions.has(extension)) {
              return true;
            }
            if (normalizedPath.startsWith(normalizedGeneratedDir)) {
              return true;
            }
            for (const fragment of ignoredPathFragments) {
              if (normalizedPath.includes(fragment)) {
                return true;
              }
            }
            return false;
          },
        });

        const readTimeInfoEntries = () => {
          const rawEntries = watcher.getTimeInfoEntries() as Map<
            string,
            WatchpackTimeInfoEntry
          >;
          const normalizedEntries = new Map<string, WatchpackTimeInfoEntry>();
          for (const [path, info] of rawEntries) {
            normalizedEntries.set(normalizePath(path), info);
          }
          return normalizedEntries;
        };

        let rebuildQueue = Promise.resolve();

        const enqueue = (task: () => Promise<void>) => {
          rebuildQueue = rebuildQueue.then(task).catch((error) => {
            console.error('Failed to process file change', error);
          });
          return rebuildQueue;
        };

        const fullRebuild = async () => {
          const newInputFiles = await this.getInputFiles();
          options.inputFiles = newInputFiles;

          await stepsCtx!.dispose();
          await workflowsCtx.interimBundleCtx.dispose();

          const newCombined = await this.buildCombinedFunction(options);
          if (!newCombined?.stepsContext) {
            throw new Error(
              'Invariant: expected steps build context after rebuild'
            );
          }
          stepsCtx = newCombined.stepsContext;

          if (!newCombined?.interimBundleCtx || !newCombined?.bundleFinal) {
            throw new Error(
              'Invariant: expected workflows bundle context after rebuild'
            );
          }
          workflowsCtx = {
            interimBundleCtx: newCombined.interimBundleCtx,
            bundleFinal: newCombined.bundleFinal,
          };

          await writeManifest(newCombined.manifest);
        };

        const logBuildMessages = (
          result: {
            errors?: import('esbuild').Message[];
            warnings?: import('esbuild').Message[];
          },
          label: string
        ) => {
          const logByType = (
            messages: import('esbuild').Message[] | undefined,
            method: 'error' | 'warn'
          ) => {
            if (!messages || messages.length === 0) {
              return;
            }
            const descriptor = method === 'error' ? 'errors' : 'warnings';
            console[method](`${descriptor} while rebuilding ${label}`);
            for (const message of messages) {
              console[method](message);
            }
          };

          logByType(result.errors, 'error');
          logByType(result.warnings, 'warn');
        };

        const rebuildExistingFiles = async () => {
          const rebuiltStepStart = Date.now();
          const stepsResult = await stepsCtx!.rebuild();
          logBuildMessages(stepsResult, 'steps bundle');
          console.log(
            'Rebuilt steps bundle',
            `${Date.now() - rebuiltStepStart}ms`
          );

          const rebuiltWorkflowStart = Date.now();
          const workflowResult = await workflowsCtx.interimBundleCtx.rebuild();
          logBuildMessages(workflowResult, 'workflows bundle');

          if (
            !workflowResult.outputFiles ||
            workflowResult.outputFiles.length === 0
          ) {
            console.error(
              'No output generated while rebuilding workflows bundle'
            );
            return;
          }
          await workflowsCtx.bundleFinal(workflowResult.outputFiles[0].text);
          console.log(
            'Rebuilt workflow bundle',
            `${Date.now() - rebuiltWorkflowStart}ms`
          );
        };

        const isWatchableFile = (path: string) =>
          watchableExtensions.has(extname(path));

        const getComparableTimestamp = (entry: WatchpackTimeInfoEntry) =>
          entry.timestamp ?? entry.safeTime;

        const findRemovedFiles = (
          currentEntries: Map<string, WatchpackTimeInfoEntry>,
          previousEntries: Map<string, WatchpackTimeInfoEntry>
        ) => {
          const removed: string[] = [];
          for (const path of previousEntries.keys()) {
            if (!currentEntries.has(path) && isWatchableFile(path)) {
              removed.push(path);
            }
          }
          return removed;
        };

        const findAddedAndModifiedFiles = (
          currentEntries: Map<string, WatchpackTimeInfoEntry>,
          previousEntries: Map<string, WatchpackTimeInfoEntry>
        ) => {
          const added: string[] = [];
          const modified: string[] = [];

          for (const [path, info] of currentEntries) {
            if (!isWatchableFile(path)) {
              continue;
            }

            const previous = previousEntries.get(path);
            if (!previous) {
              added.push(path);
              continue;
            }

            if (
              getComparableTimestamp(info) !== getComparableTimestamp(previous)
            ) {
              modified.push(path);
            }
          }

          return { added, modified };
        };

        const determineFileChanges = (
          currentEntries: Map<string, WatchpackTimeInfoEntry>,
          previousEntries: Map<string, WatchpackTimeInfoEntry>
        ) => {
          const removedFiles = findRemovedFiles(
            currentEntries,
            previousEntries
          );
          const { added, modified } = findAddedAndModifiedFiles(
            currentEntries,
            previousEntries
          );

          return {
            addedFiles: added,
            modifiedFiles: modified,
            removedFiles,
          };
        };

        let isInitial = true;

        watcher.on('aggregated', () => {
          const currentEntries = readTimeInfoEntries();
          const { addedFiles, modifiedFiles, removedFiles } =
            determineFileChanges(currentEntries, previousTimeInfo);

          previousTimeInfo = currentEntries;

          if (isInitial) {
            isInitial = false;
            return;
          }

          if (
            addedFiles.length === 0 &&
            modifiedFiles.length === 0 &&
            removedFiles.length === 0
          ) {
            return;
          }

          for (const removal of removedFiles) {
            knownFiles.delete(removal);
          }
          for (const added of addedFiles) {
            knownFiles.add(added);
          }

          enqueue(async () => {
            if (addedFiles.length > 0 || removedFiles.length > 0) {
              await fullRebuild();
              return;
            }

            if (modifiedFiles.length > 0) {
              await rebuildExistingFiles();
            }
          });
        });

        watcher.watch({
          directories: [this.config.workingDir],
          startTime: 0,
        });
      }
    }

    protected async getInputFiles(): Promise<string[]> {
      const inputFiles = await super.getInputFiles();
      return inputFiles.filter((item) => {
        // Match App Router entrypoints: route.ts, page.ts, layout.ts in app/ or src/app/ directories
        // Matches: /app/page.ts, /app/dashboard/page.ts, /src/app/route.ts, etc.
        if (
          item.match(
            /(^|.*[/\\])(app|src[/\\]app)([/\\](route|page|layout)\.|[/\\].*[/\\](route|page|layout)\.)/
          )
        ) {
          return true;
        }
        // Match Pages Router entrypoints: files in pages/ or src/pages/
        if (item.match(/[/\\](pages|src[/\\]pages)[/\\]/)) {
          return true;
        }
        return false;
      });
    }

    private async writeFunctionsConfig(outputDir: string) {
      // we don't run this in development mode as it's not needed
      if (process.env.NODE_ENV === 'development') {
        return;
      }

      // V2 combined config: single trigger handles both workflow and step execution.
      // The step route no longer needs its own trigger since steps are executed
      // inline by the combined handler or queued back to __wkf_workflow_* with stepId.
      const generatedConfig = {
        version: '0',
        workflows: {
          maxDuration: 'max',
          experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
        },
      };

      await writeFile(
        join(outputDir, '.well-known/workflow/v1/config.json'),
        JSON.stringify(generatedConfig, null, 2)
      );
    }

    /**
     * V2: Build combined route that handles both workflow and step execution.
     */
    private async buildCombinedFunction({
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsconfigPath?: string;
    }) {
      const flowRouteDir = join(workflowGeneratedDir, 'flow');
      await mkdir(flowRouteDir, { recursive: true });

      return await this.createCombinedBundle({
        format: 'esm',
        inputFiles,
        stepsOutfile: join(flowRouteDir, '__step_registrations.js'),
        flowOutfile: join(flowRouteDir, 'route.js'),
        bundleFinalOutput: false,
        externalizeNonSteps: true,
        tsconfigPath,
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
      const pagesDir = resolve(this.config.workingDir, 'pages');
      const srcPagesDir = resolve(this.config.workingDir, 'src/pages');

      // Helper to check if a path exists and is a directory
      const isDirectory = async (path: string): Promise<boolean> => {
        try {
          await access(path, constants.F_OK);
          const stats = await stat(path);
          if (!stats.isDirectory()) {
            throw new Error(`Path exists but is not a directory: ${path}`);
          }
          return true;
        } catch (e) {
          if (e instanceof Error && e.message.includes('not a directory')) {
            throw e;
          }
          return false;
        }
      };

      // Check if app directory exists
      if (await isDirectory(appDir)) {
        return appDir;
      }

      // Check if src/app directory exists
      if (await isDirectory(srcAppDir)) {
        return srcAppDir;
      }

      // If no app directory exists, check for pages directory and create app next to it
      if (await isDirectory(pagesDir)) {
        // Create app directory next to pages directory
        await mkdir(appDir, { recursive: true });
        return appDir;
      }

      if (await isDirectory(srcPagesDir)) {
        // Create src/app directory next to src/pages directory
        await mkdir(srcAppDir, { recursive: true });
        return srcAppDir;
      }

      throw new Error(
        'Could not find Next.js app or pages directory. Expected one of: "app", "src/app", "pages", or "src/pages" to exist.'
      );
    }
  }

  CachedNextBuilderEager = NextBuilder;
  return NextBuilder;
}
