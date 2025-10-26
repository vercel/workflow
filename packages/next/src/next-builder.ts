import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import Watchpack from 'watchpack';
import {
  BaseBuilder,
  STEP_QUEUE_TRIGGER,
  WORKFLOW_QUEUE_TRIGGER,
} from '@workflow/builders';

export class NextBuilder extends BaseBuilder {
  async build() {
    const outputDir = await this.findAppDirectory();
    const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });
    // ignore the generated assets

    await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');

    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };

    const stepsBuildContext = await this.buildStepsFunction(options);
    const workflowsBundle = await this.buildWorkflowsFunction(options);
    await this.buildWebhookRoute({ workflowGeneratedDir });
    await this.writeFunctionsConfig(outputDir);

    if (this.config.watch) {
      if (!stepsBuildContext) {
        throw new Error(
          'Invariant: expected steps build context in watch mode'
        );
      }
      if (!workflowsBundle) {
        throw new Error('Invariant: expected workflows bundle in watch mode');
      }

      let stepsCtx = stepsBuildContext;
      let workflowsCtx = workflowsBundle;

      const normalizePath = (pathname: string) => pathname.replace(/\\/g, '/');
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

        await stepsCtx.dispose();
        const newStepsCtx = await this.buildStepsFunction(options);
        if (!newStepsCtx) {
          throw new Error(
            'Invariant: expected steps build context after rebuild'
          );
        }
        stepsCtx = newStepsCtx;

        await workflowsCtx.interimBundleCtx.dispose();
        const newWorkflowsCtx = await this.buildWorkflowsFunction(options);
        if (!newWorkflowsCtx) {
          throw new Error(
            'Invariant: expected workflows bundle context after rebuild'
          );
        }
        workflowsCtx = newWorkflowsCtx;
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
        const stepsResult = await stepsCtx.rebuild();
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
        const removedFiles = findRemovedFiles(currentEntries, previousEntries);
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
}
