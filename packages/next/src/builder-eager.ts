import assert from 'node:assert';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  NextConfig as BuilderNextConfig,
  WorkflowManifest,
} from '@workflow/builders';
import chokidar from 'chokidar';
import type { NextConfig as ProjectNextConfig } from 'next';
import { createWatchIgnorePredicate } from './watch-ignore.js';
import {
  classifyRebuild,
  createRebuildScheduler,
  createSourceSnapshot,
  getAffectedWorkflowFiles,
  getRelevantFiles,
  type HotRebuildTarget,
  isSourceFile,
  readSourceSnapshots,
  type SourceSnapshot,
  sourceSnapshotsMatch,
} from './watch-rebuild.js';

let CachedNextBuilderEager: any;
const importEsm = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string
) => Promise<T>;

const rootEntrypoint = /^(?:instrumentation|middleware|proxy)$/;
const rootModuleCandidate =
  /^(?:instrumentation-client|mdx-components)\.(?:mjs|[jt]sx?)$/;
const rootModuleNames = ['instrumentation-client', 'mdx-components'];
const rootModuleExtensions = ['js', 'mjs', 'tsx', 'ts', 'jsx'];

export function createNextEntrypointMatcher({
  pageExtensions,
  bundler,
  globalNotFound,
}: {
  pageExtensions: readonly string[];
  bundler: 'webpack' | 'turbopack' | 'rspack';
  globalNotFound: boolean;
}) {
  const extensions = [...pageExtensions].sort((a, b) => b.length - a.length);
  const appEntrypoint = new RegExp(
    `^(?:page|route|layout|default|error|loading|template|not-found|forbidden|unauthorized|sitemap|(?:icon|apple-icon|opengraph-image|twitter-image)\\d${bundler === 'turbopack' ? '*' : '?'})$`
  );
  const appRootEntrypoint = new RegExp(
    `^(?:global-error${globalNotFound ? '|global-not-found' : ''}|robots|manifest)$`
  );
  const rootModuleEntrypoint = new RegExp(
    `^(?:instrumentation-client${pageExtensions.some((extension) => /(?:^|\.)mdx?$/.test(extension)) ? '|mdx-components' : ''})\\.(?:mjs|[jt]sx?)$`
  );

  return (entry: string): boolean => {
    if (/\.d\.(?:cts|mts|ts)$/.test(entry)) return false;

    const sourceEntry = entry.replace(/^src\//, '');
    const path = sourceEntry.split('/');
    const filename = path[path.length - 1];
    if (rootModuleEntrypoint.test(sourceEntry)) return true;

    const extension = extensions.find((extension) =>
      sourceEntry.endsWith(`.${extension}`)
    );
    if (!extension) return false;

    const name = filename.slice(0, -extension.length - 1);
    if (path[0] === 'pages') return true;

    if (path[0] === 'app') {
      const segments = path.slice(1, -1);
      if (segments.some((segment) => segment.startsWith('_'))) return false;

      return (
        appEntrypoint.test(name) ||
        (path.length === 2 && appRootEntrypoint.test(name))
      );
    }

    return rootEntrypoint.test(sourceEntry.slice(0, -extension.length - 1));
  };
}

// Create the eager Next builder dynamically by extending the ESM BaseBuilder.
// Exported as getNextBuilderEager() to allow CommonJS modules to import from
// the ESM @workflow/builders package via dynamic import at runtime.
export async function getNextBuilderEager(
  buildersModule?: typeof import('@workflow/builders')
) {
  if (CachedNextBuilderEager) {
    return CachedNextBuilderEager;
  }

  const {
    BaseBuilder: BaseBuilderClass,
    analyzeWorkflowSource,
    getWorkflowQueueTrigger,
    writeFileIfChanged,
  } = buildersModule ??
  (await importEsm<typeof import('@workflow/builders')>('@workflow/builders'));

  class NextBuilder extends BaseBuilderClass {
    protected declare config: BuilderNextConfig & {
      pageExtensions: NonNullable<ProjectNextConfig['pageExtensions']>;
      distDir: string;
      globalNotFound: boolean;
    };

    async build() {
      const outputDir = await this.findAppDirectory();
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });
      if (!this.config.watch) {
        // Production build caches may still contain the retired step route.
        await rm(join(workflowGeneratedDir, 'step'), {
          recursive: true,
          force: true,
        });
      }
      await writeFileIfChanged(join(workflowGeneratedDir, '.gitignore'), '*');

      const normalizePath = (pathname: string) =>
        (isAbsolute(pathname)
          ? pathname
          : resolve(this.config.workingDir, pathname)
        ).replace(/\\/g, '/');
      let relevantFiles = new Set<string>();
      const isWatchableFile = (path: string) =>
        isSourceFile(path) || relevantFiles.has(path);
      const normalizedDistDir = normalizePath(this.config.distDir);
      const isIgnoredWatchPath = createWatchIgnorePredicate({
        workingDir: this.config.workingDir,
        projectRoot: this.transformProjectRoot,
        extraFragments: [workflowGeneratedDir.replace(/\\/g, '/')],
      });
      const logDevHmr = (...args: unknown[]) => {
        if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
          console.log(...args);
        }
      };

      type WatchEvent = {
        kind: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
        pathname: string;
      };
      let watchGeneration = 0;
      let handleWatchEvent = async (_event: WatchEvent) => {};
      const attachWatchEvents = (
        currentWatcher: ReturnType<typeof chokidar.watch>,
        mode: 'source' | 'dependencies'
      ) => {
        currentWatcher.on('all', (kind, pathname) => {
          if (
            kind === 'all' ||
            kind === 'error' ||
            kind === 'raw' ||
            kind === 'ready'
          ) {
            throw new Error(`Unknown watch event: ${kind}`);
          }
          if (
            mode === 'source' &&
            (kind === 'addDir' || kind === 'unlinkDir')
          ) {
            return;
          }
          watchGeneration++;
          void handleWatchEvent({ kind, pathname }).catch((error) => {
            console.error('Failed to process file change', error);
          });
        });
      };
      // Chokidar 4 registers an fs.watch per directory, so prune ignored trees
      // before it walks the project.
      const watcher = this.config.watch
        ? chokidar.watch(this.config.workingDir, {
            ignoreInitial: true,
            followSymlinks: true,
            ignored: (pathname, stats) => {
              const normalizedPath = normalizePath(String(pathname));
              if (
                normalizedPath === normalizedDistDir ||
                normalizedPath.startsWith(`${normalizedDistDir}/`) ||
                isIgnoredWatchPath(normalizedPath)
              ) {
                return true;
              }
              return stats?.isFile() === true && !isSourceFile(normalizedPath);
            },
          })
        : undefined;
      let dependencyWatcher: ReturnType<typeof chokidar.watch> | undefined;
      const closeWatcherOnError = async <T>(promise: Promise<T>) => {
        try {
          return await promise;
        } catch (error) {
          await Promise.all([watcher?.close(), dependencyWatcher?.close()]);
          throw error;
        }
      };
      if (watcher) {
        attachWatchEvents(watcher, 'source');
        watcher.on('error', (error) => {
          console.error('Workflow dev watcher error', error);
        });
        await closeWatcherOnError(once(watcher, 'ready'));
      }

      const inputFiles = await closeWatcherOnError(this.getInputFiles());
      const tsconfigPath = await closeWatcherOnError(this.findTsConfigPath());

      const options = {
        inputFiles,
        workflowGeneratedDir,
        tsconfigPath,
      };

      // V2: Build combined route (replaces separate step + flow routes)
      const combinedResult = await closeWatcherOnError(
        this.buildCombinedFunction(options)
      );
      await closeWatcherOnError(
        this.buildWebhookRoute({ workflowGeneratedDir })
      );

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
          if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
            await writeFileIfChanged(
              join(publicManifestDir, '.gitignore'),
              '*'
            );
          }
          // Written from the same string rather than copied, so an unchanged
          // manifest leaves the public copy untouched too.
          await writeFileIfChanged(
            join(publicManifestDir, 'manifest.json'),
            manifestJson
          );
        }
      };

      await closeWatcherOnError(writeManifest(combinedResult?.manifest));

      await closeWatcherOnError(this.writeFunctionsConfig(outputDir));

      if (this.config.watch) {
        assert(watcher, 'Invariant: expected workflow watcher in watch mode');
        if (!combinedResult?.interimBundleCtx || !combinedResult.bundleFinal) {
          await watcher.close();
          throw new Error(
            'Invariant: expected workflow build context in watch mode'
          );
        }

        let workflowsCtx = {
          interimBundleCtx: combinedResult.interimBundleCtx,
          bundleFinal: combinedResult.bundleFinal,
        };
        let discoveredEntries = combinedResult.discoveredEntries;
        let stepsManifest = combinedResult.stepsManifest;
        let workflowsManifest = combinedResult.workflowsManifest;
        const stepsOutfile = join(
          workflowGeneratedDir,
          'flow',
          '__step_registrations.js'
        );

        let affectedWorkflowFiles = getAffectedWorkflowFiles({
          discoveredEntries,
          importGraph: discoveredEntries.importParents,
          normalizePath,
        });
        relevantFiles = getRelevantFiles({
          discoveredEntries,
          inputFiles: options.inputFiles,
          normalizePath,
        });

        const replaceDependencyWatcher = async () => {
          const dependencyDirectories = new Set(
            [...relevantFiles].map(dirname)
          );
          const nextWatcher = chokidar.watch([...dependencyDirectories], {
            depth: 0,
            ignoreInitial: true,
            followSymlinks: true,
          });
          attachWatchEvents(nextWatcher, 'dependencies');
          nextWatcher.on('error', (error) => {
            console.error('Workflow dev watcher error', error);
          });
          try {
            await once(nextWatcher, 'ready');
          } catch (error) {
            await nextWatcher.close();
            throw error;
          }

          const previousWatcher = dependencyWatcher;
          dependencyWatcher = nextWatcher;
          await previousWatcher?.close();
        };
        await closeWatcherOnError(replaceDependencyWatcher());

        let sourceSnapshots = new Map<string, SourceSnapshot>();

        const readSourceSnapshot = (file: string) =>
          createSourceSnapshot({ file, analyzeWorkflowSource });

        const snapshotSources = () =>
          readSourceSnapshots({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
            readSnapshot: readSourceSnapshot,
          });

        const mergeCombinedManifest = (
          nextStepsManifest: WorkflowManifest
        ): WorkflowManifest => ({
          ...nextStepsManifest,
          workflows: {
            ...nextStepsManifest.workflows,
            ...workflowsManifest.workflows,
          },
          classes: {
            ...nextStepsManifest.classes,
            ...workflowsManifest.classes,
          },
        });

        const hotRebuild = async (target: HotRebuildTarget) => {
          if (target !== 'workflows') {
            stepsManifest = await this.createStepSourceRegistrationFile({
              inputFiles: options.inputFiles,
              outfile: stepsOutfile,
              tsconfigPath,
              discoveredEntries,
            });
          }

          if (target !== 'steps') {
            const workflowResult =
              await workflowsCtx.interimBundleCtx.rebuild();
            const workflowOutput = workflowResult.outputFiles?.[0]?.text;
            if (!workflowOutput) {
              throw new Error(
                'Invariant: expected workflow output from hot rebuild'
              );
            }

            await workflowsCtx.bundleFinal(workflowOutput);
          }

          await writeManifest(mergeCombinedManifest(stepsManifest));
        };

        const fullRebuild = async () => {
          this.clearDiscoveredEntriesCache();
          const newInputFiles = await this.getInputFiles();
          options.inputFiles = newInputFiles;

          // Snapshot before building so edits made during the build remain
          // dirty and trigger the file event already queued behind this task.
          const nextSourceSnapshots = await snapshotSources();

          const newCombined = await this.buildCombinedFunction(options);
          if (!newCombined?.interimBundleCtx || !newCombined?.bundleFinal) {
            throw new Error(
              'Invariant: expected workflows bundle context after rebuild'
            );
          }

          const previousWorkflowsCtx = workflowsCtx.interimBundleCtx;
          discoveredEntries = newCombined.discoveredEntries;
          affectedWorkflowFiles = getAffectedWorkflowFiles({
            discoveredEntries,
            importGraph: discoveredEntries.importParents,
            normalizePath,
          });
          stepsManifest = newCombined.stepsManifest;
          workflowsManifest = newCombined.workflowsManifest;
          workflowsCtx = {
            interimBundleCtx: newCombined.interimBundleCtx,
            bundleFinal: newCombined.bundleFinal,
          };
          relevantFiles = getRelevantFiles({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
          });

          await previousWorkflowsCtx.dispose();

          await writeManifest(newCombined.manifest);
          sourceSnapshots = nextSourceSnapshots;
          return sourceSnapshotsMatch(
            nextSourceSnapshots,
            await snapshotSources()
          );
        };

        const runFullRebuild = async () => {
          const generation = watchGeneration;
          logDevHmr('workflow dev hmr: full rediscovery');
          const buildWasStable = await fullRebuild();
          await replaceDependencyWatcher();
          const finalSnapshots = await snapshotSources();
          return (
            buildWasStable &&
            sourceSnapshotsMatch(sourceSnapshots, finalSnapshots) &&
            generation === watchGeneration
          );
        };

        const processFileChanges = async (files: string[]) => {
          const decision = await classifyRebuild({
            affectedWorkflowFiles,
            files,
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
            readSnapshot: readSourceSnapshot,
            sourceSnapshots,
          });
          switch (decision.kind) {
            case 'skip':
              logDevHmr('workflow dev hmr: skip');
              break;
            case 'hot':
              logDevHmr(`workflow dev hmr: hot rebuild ${decision.target}`);
              await hotRebuild(decision.target);
              break;
            case 'full':
              scheduleRebuild({ kind: 'full' });
              return;
            default:
              decision satisfies never;
              throw new Error('Unknown rebuild decision');
          }
          for (const [file, snapshot] of decision.snapshots) {
            sourceSnapshots.set(file, snapshot);
          }
        };

        const scheduleRebuild = createRebuildScheduler(
          async (request) => {
            try {
              switch (request.kind) {
                case 'files':
                  await processFileChanges(request.files);
                  return;
                case 'full':
                  if (!(await runFullRebuild())) {
                    scheduleRebuild({ kind: 'full' });
                  }
                  return;
                default:
                  request satisfies never;
                  throw new Error('Unknown scheduled rebuild');
              }
            } catch (error) {
              console.error('Failed to process file change', error);
            }
          },
          () => logDevHmr('workflow dev hmr: idle')
        );
        const handleFileChanged = async (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const realFilePath = normalizePath(await realpath(normalizedPath));
          scheduleRebuild({
            kind: 'files',
            files: [
              relevantFiles.has(realFilePath) ? realFilePath : normalizedPath,
            ],
          });
        };

        const scheduleFullRebuild = (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }
          scheduleRebuild({ kind: 'full' });
        };

        const startupWasStable = await closeWatcherOnError(runFullRebuild());

        handleWatchEvent = async (event) => {
          switch (event.kind) {
            case 'add':
            case 'unlink':
              scheduleFullRebuild(event.pathname);
              return;
            case 'addDir':
            case 'unlinkDir':
              scheduleRebuild({ kind: 'full' });
              return;
            case 'change':
              await handleFileChanged(event.pathname);
              return;
            default:
              event.kind satisfies never;
              throw new Error('Unknown watch event');
          }
        };
        logDevHmr('workflow dev hmr: ready');
        if (startupWasStable) {
          logDevHmr('workflow dev hmr: idle');
        } else {
          scheduleRebuild({ kind: 'full' });
        }
      }
    }

    protected async getInputFiles(): Promise<string[]> {
      const inputFiles = await super.getInputFiles();
      const appDirectory = relative(
        this.config.workingDir,
        await this.findAppDirectory()
      ).replaceAll('\\', '/');
      assert(appDirectory === 'app' || appDirectory === 'src/app');
      const sourceDirectory = appDirectory === 'app' ? '.' : 'src';
      const bundler = process.env.NEXT_RSPACK
        ? 'rspack'
        : process.env.TURBOPACK
          ? 'turbopack'
          : 'webpack';
      const isNextEntrypoint = createNextEntrypointMatcher({
        pageExtensions: this.config.pageExtensions,
        bundler,
        globalNotFound: this.config.globalNotFound,
      });
      const inputFileSet = new Set(inputFiles);
      const rootModuleFiles = new Set(
        rootModuleNames.flatMap((name) => {
          const directories =
            name === 'mdx-components' && bundler === 'turbopack'
              ? ['', 'src']
              : ['src', ''];
          const file = directories
            .flatMap((directory) =>
              rootModuleExtensions.map((extension) =>
                join(this.config.workingDir, directory, `${name}.${extension}`)
              )
            )
            .find((candidate) => inputFileSet.has(candidate));
          return file ? [file] : [];
        })
      );

      return inputFiles.filter((file) => {
        const entry = relative(this.config.workingDir, file).replaceAll(
          '\\',
          '/'
        );
        const rootModule = entry.startsWith('src/') ? entry.slice(4) : entry;
        if (rootModuleCandidate.test(rootModule)) {
          return rootModuleFiles.has(file) && isNextEntrypoint(entry);
        }
        if (entry.startsWith('src/') !== (sourceDirectory === 'src')) {
          return false;
        }
        return isNextEntrypoint(entry);
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
          experimentalTriggers: [getWorkflowQueueTrigger()],
        },
      };

      await writeFileIfChanged(
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

      const result = await this.createCombinedBundle({
        format: 'esm',
        inputFiles,
        stepsOutfile: join(flowRouteDir, '__step_registrations.js'),
        flowOutfile: join(flowRouteDir, 'route.js'),
        bundleFinalOutput: false,
        externalizeNonSteps: true,
        sourceStepRegistrationImports: true,
        tsconfigPath,
      });
      assert(
        result.stepsContext === undefined,
        'Invariant: source step registrations must not create an esbuild context'
      );
      return result;
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
