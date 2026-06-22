import { constants } from 'node:fs';
import { access, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
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
    STEP_QUEUE_TRIGGER,
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
      // ignore the generated assets

      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');

      const inputFiles = await this.getInputFiles();
      const tsconfigPath = await this.findTsConfigPath();

      const options = {
        inputFiles,
        workflowGeneratedDir,
        tsconfigPath,
      };

      const { manifest: stepsManifest, context: stepsBuildContext } =
        await this.buildStepsFunction(options);
      const workflowsBundle = await this.buildWorkflowsFunction(options);
      await this.buildWebhookRoute({ workflowGeneratedDir });

      // Merge manifests from both bundles
      const manifest = {
        steps: { ...stepsManifest.steps, ...workflowsBundle?.manifest?.steps },
        workflows: {
          ...stepsManifest.workflows,
          ...workflowsBundle?.manifest?.workflows,
        },
        classes: {
          ...stepsManifest.classes,
          ...workflowsBundle?.manifest?.classes,
        },
      };

      // Write unified manifest to workflow generated directory
      const workflowBundlePath = join(workflowGeneratedDir, 'flow/route.js');
      const manifestJson = await this.createManifest({
        workflowBundlePath,
        manifestDir: workflowGeneratedDir,
        manifest,
      });

      // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
      // Next.js serves files from public/ at the root URL.
      if (this.shouldExposePublicManifest && manifestJson) {
        const publicManifestDir = join(
          this.config.workingDir,
          'public/.well-known/workflow/v1'
        );
        await mkdir(publicManifestDir, { recursive: true });
        if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
          await writeFile(join(publicManifestDir, '.gitignore'), '*');
        }
        await copyFile(
          join(workflowGeneratedDir, 'manifest.json'),
          join(publicManifestDir, 'manifest.json')
        );
      }

      await this.writeFunctionsConfig(outputDir);

      if (this.config.watch) {
        if (!stepsBuildContext) {
          throw new Error(
            'Invariant: expected steps build context in watch mode'
          );
        }
        if (
          !workflowsBundle?.interimBundleCtx ||
          !workflowsBundle?.bundleFinal
        ) {
          throw new Error('Invariant: expected workflows bundle in watch mode');
        }

        let stepsCtx = stepsBuildContext;
        // These are safe to assert as non-null because we checked above
        let workflowsCtx = {
          interimBundleCtx: workflowsBundle.interimBundleCtx!,
          bundleFinal: workflowsBundle.bundleFinal!,
        };

        const normalizePath = (pathname: string) =>
          pathname.replace(/\\/g, '/');
        type WatchpackTimeInfoEntry = {
          safeTime: number;
          timestamp?: number;
        };
        type FileChanges = {
          addedFiles: string[];
          modifiedFiles: string[];
          removedFiles: string[];
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
          this.clearDiscoveredEntriesCache();
          const newInputFiles = await this.getInputFiles();
          options.inputFiles = newInputFiles;

          await stepsCtx.dispose();
          const { context: newStepsCtx } =
            await this.buildStepsFunction(options);
          if (!newStepsCtx) {
            throw new Error(
              'Invariant: expected steps build context after rebuild'
            );
          }
          stepsCtx = newStepsCtx;

          await workflowsCtx.interimBundleCtx.dispose();
          const newWorkflowsCtx = await this.buildWorkflowsFunction(options);
          if (
            !newWorkflowsCtx?.interimBundleCtx ||
            !newWorkflowsCtx?.bundleFinal
          ) {
            throw new Error(
              'Invariant: expected workflows bundle context after rebuild'
            );
          }
          workflowsCtx = {
            interimBundleCtx: newWorkflowsCtx.interimBundleCtx,
            bundleFinal: newWorkflowsCtx.bundleFinal,
          };
        };

        const isWatchableFile = (path: string) =>
          watchableExtensions.has(extname(path));

        const normalizeWatchpackPaths = (paths?: Iterable<string>) => {
          const normalizedPaths: string[] = [];
          if (!paths) {
            return normalizedPaths;
          }

          for (const path of paths) {
            const normalizedPath = normalizePath(path);
            if (isWatchableFile(normalizedPath)) {
              normalizedPaths.push(normalizedPath);
            }
          }

          return normalizedPaths;
        };

        const unique = (paths: string[]) => [...new Set(paths)];

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
        ): FileChanges => {
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

        const mergeFileChanges = ({
          currentEntries,
          previousEntries,
          timestampChanges,
          eventChangedFiles,
          eventRemovedFiles,
        }: {
          currentEntries: Map<string, WatchpackTimeInfoEntry>;
          previousEntries: Map<string, WatchpackTimeInfoEntry>;
          timestampChanges: FileChanges;
          eventChangedFiles: string[];
          eventRemovedFiles: string[];
        }): FileChanges => ({
          addedFiles: unique([
            ...timestampChanges.addedFiles,
            ...eventChangedFiles.filter(
              (path) => currentEntries.has(path) && !previousEntries.has(path)
            ),
          ]),
          modifiedFiles: unique([
            ...timestampChanges.modifiedFiles,
            ...eventChangedFiles,
          ]),
          removedFiles: unique([
            ...timestampChanges.removedFiles,
            ...eventRemovedFiles,
          ]),
        });

        const hasFileChanges = ({
          addedFiles,
          modifiedFiles,
          removedFiles,
        }: FileChanges) =>
          addedFiles.length > 0 ||
          modifiedFiles.length > 0 ||
          removedFiles.length > 0;

        let isInitial = true;

        watcher.on(
          'aggregated',
          (changes?: Set<string>, removals?: Set<string>) => {
            const currentEntries = readTimeInfoEntries();
            const eventChangedFiles = normalizeWatchpackPaths(changes);
            const eventRemovedFiles = normalizeWatchpackPaths(removals);
            const timestampChanges = determineFileChanges(
              currentEntries,
              previousTimeInfo
            );

            const fileChanges = mergeFileChanges({
              currentEntries,
              previousEntries: previousTimeInfo,
              timestampChanges,
              eventChangedFiles,
              eventRemovedFiles,
            });

            previousTimeInfo = currentEntries;

            if (isInitial) {
              isInitial = false;
              if (
                eventChangedFiles.length === 0 &&
                eventRemovedFiles.length === 0
              ) {
                return;
              }
            }

            if (!hasFileChanges(fileChanges)) {
              return;
            }

            enqueue(async () => {
              await fullRebuild();
            });
          }
        );

        watcher.watch({
          directories: [this.config.workingDir],
          startTime: Date.now(),
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
      const generatedConfig = {
        version: '0',
        steps: {
          maxDuration: 'max',
          experimentalTriggers: [STEP_QUEUE_TRIGGER],
        },
        workflows: {
          maxDuration: 'max',
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
      tsconfigPath,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsconfigPath?: string;
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
        tsconfigPath,
      });
    }

    private async buildWorkflowsFunction({
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsconfigPath?: string;
    }) {
      const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
      await mkdir(workflowsRouteDir, { recursive: true });
      return await this.createWorkflowsBundle({
        format: 'esm',
        outfile: join(workflowsRouteDir, 'route.js'),
        bundleFinalOutput: false,
        inputFiles,
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
