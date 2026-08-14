import { constants, type Dirent } from 'node:fs';
import { access, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  NextConfig as BuilderNextConfig,
  WorkflowManifest,
} from '@workflow/builders';
import chokidar from 'chokidar';
import type { NextConfig as ProjectNextConfig } from 'next';
import { createWatchIgnorePredicate } from './watch-ignore.js';
import {
  classifyRebuild,
  createSourceSnapshot,
  type FileChanges,
  getRelevantFiles,
  pinBaselinesAcrossFullRebuild,
  replaceSourceSnapshots,
  type SourceSnapshot,
} from './watch-rebuild.js';

let CachedNextBuilderEager: any;
const importEsm = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string
) => Promise<T>;

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
    getWorkflowQueueTrigger,
    detectWorkflowPatterns,
    parentHasChild,
    writeFileIfChanged,
  } = buildersModule ??
  (await importEsm<typeof import('@workflow/builders')>('@workflow/builders'));

  class NextBuilder extends BaseBuilderClass {
    protected declare config: BuilderNextConfig & {
      pageExtensions: NonNullable<ProjectNextConfig['pageExtensions']>;
      distDir: string;
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

      await writeManifest(combinedResult?.manifest);

      await this.writeFunctionsConfig(outputDir);

      if (this.config.watch) {
        // TODO: implement watch mode for combined bundle
        // For now, fall back to full rebuild on file changes
        if (!combinedResult?.interimBundleCtx || !combinedResult.bundleFinal) {
          throw new Error(
            'Invariant: expected workflow build context in watch mode'
          );
        }

        // Step registrations may be emitted as source imports without an
        // esbuild context when externalizeNonSteps is enabled.
        let stepsCtx = combinedResult.stepsContext;
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

        const normalizePath = (pathname: string) =>
          (isAbsolute(pathname)
            ? pathname
            : resolve(this.config.workingDir, pathname)
          ).replace(/\\/g, '/');
        const sourceSnapshots = new Map<string, SourceSnapshot>();

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
        const normalizedGeneratedDir = workflowGeneratedDir.replace(/\\/g, '/');
        const normalizedDistDir = normalizePath(this.config.distDir);

        // Prune the dev watch set to keep chokidar from registering an
        // fs.watch per directory across the whole project tree (chokidar 4
        // dropped fsevents, so on macOS that exhausts the fd limit -> EMFILE
        // on large monorepos). This honors `.gitignore` and the
        // WORKFLOW_DEV_WATCH_IGNORED_PATHS env var in addition to the
        // built-in fragments. The generated workflow dir is passed as an
        // extra fragment so it is pruned regardless of `.gitignore`.
        const isIgnoredWatchPath = createWatchIgnorePredicate({
          workingDir: this.config.workingDir,
          projectRoot: this.transformProjectRoot,
          extraFragments: [normalizedGeneratedDir],
        });

        const hasIgnoredPathFragment = (normalizedPath: string) => {
          if (
            normalizedPath === normalizedDistDir ||
            normalizedPath.startsWith(`${normalizedDistDir}/`)
          ) {
            return true;
          }
          return isIgnoredWatchPath(normalizedPath);
        };

        let rebuildQueue = Promise.resolve();

        const enqueue = (task: () => Promise<void>) => {
          rebuildQueue = rebuildQueue.then(task).catch((error) => {
            console.error('Failed to process file change', error);
          });
          return rebuildQueue;
        };

        const readSourceSnapshot = (file: string) =>
          createSourceSnapshot({ file, detectWorkflowPatterns });

        const refreshSourceSnapshots = () =>
          replaceSourceSnapshots({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
            readSnapshot: readSourceSnapshot,
            sourceSnapshots,
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

        const hotRebuild = async (refreshStepRegistrations: boolean) => {
          if (refreshStepRegistrations) {
            if (stepsCtx) {
              await stepsCtx.rebuild();
            } else {
              stepsManifest = await this.createStepSourceRegistrationFile({
                inputFiles: options.inputFiles,
                outfile: stepsOutfile,
                tsconfigPath,
                discoveredEntries,
              });
            }
          }

          const workflowResult = await workflowsCtx.interimBundleCtx.rebuild();
          await workflowsCtx.bundleFinal(workflowResult);
          await writeManifest(mergeCombinedManifest(stepsManifest));
        };

        // The pin helper owns the capture-before-build / restore-after-
        // refresh ordering (including that the capture reads the CURRENT
        // discovered entries and input files, before the rebuild replaces
        // them), so an edit landing while the multi-second rebuild runs still
        // diffs against what the rebuild consumed instead of being absorbed
        // into the refreshed baseline. See `pinBaselinesAcrossFullRebuild`
        // for the full reasoning.
        const fullRebuild = () =>
          pinBaselinesAcrossFullRebuild({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
            readSnapshot: readSourceSnapshot,
            sourceSnapshots,
            rebuild: async () => {
              this.clearDiscoveredEntriesCache();
              // A definition-level change can preserve both file size and an
              // effectively identical mtime on fast/coalesced dev writes. A
              // full rediscovery must never reuse manifests from the previous
              // graph.
              this.clearManifestTransformCache();
              const newInputFiles = await this.getInputFiles();
              options.inputFiles = newInputFiles;

              await stepsCtx?.dispose();
              await workflowsCtx.interimBundleCtx.dispose();

              const newCombined = await this.buildCombinedFunction(options);
              stepsCtx = newCombined.stepsContext;
              discoveredEntries = newCombined.discoveredEntries;
              stepsManifest = newCombined.stepsManifest;
              workflowsManifest = newCombined.workflowsManifest;

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
              await refreshSourceSnapshots();
            },
          });

        const isWatchableFile = (path: string) =>
          watchableExtensions.has(extname(path));

        const readKnownFiles = async () => {
          const files = new Set<string>();
          const aliases = new Map<string, string>();
          const relevantFiles = getRelevantFiles({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
          });

          const addKnownFile = async (filePath: string) => {
            let realFilePath = filePath;
            try {
              realFilePath = normalizePath(await realpath(filePath));
            } catch {}

            const canonicalPath = relevantFiles.has(realFilePath)
              ? realFilePath
              : filePath;
            files.add(canonicalPath);
            aliases.set(filePath, canonicalPath);
            aliases.set(realFilePath, canonicalPath);
            return canonicalPath;
          };

          const visit = async (directory: string): Promise<void> => {
            let dirents: Dirent<string>[];
            try {
              dirents = await readdir(directory, { withFileTypes: true });
            } catch {
              return;
            }

            await Promise.all(
              dirents.map(async (dirent) => {
                const filePath = normalizePath(join(directory, dirent.name));
                if (hasIgnoredPathFragment(filePath)) {
                  return;
                }

                if (dirent.isDirectory()) {
                  await visit(filePath);
                  return;
                }

                let stats: Awaited<ReturnType<typeof stat>>;
                try {
                  stats = await stat(filePath);
                } catch {
                  return;
                }

                if (stats.isDirectory()) {
                  await visit(filePath);
                  return;
                }

                if (!stats.isFile() || !isWatchableFile(filePath)) {
                  return;
                }

                await addKnownFile(filePath);
              })
            );
          };

          await visit(this.config.workingDir);
          return { files, aliases, addKnownFile };
        };

        const mergeFileChanges = (
          left: FileChanges,
          right: FileChanges
        ): FileChanges => ({
          addedFiles: unique([...left.addedFiles, ...right.addedFiles]),
          modifiedFiles: unique([
            ...left.modifiedFiles,
            ...right.modifiedFiles,
          ]),
          removedFiles: unique([...left.removedFiles, ...right.removedFiles]),
        });

        const unique = (paths: string[]) => [...new Set(paths)];

        const classifyFileChanges = ({
          changedFiles,
          knownFiles,
          removedFiles,
        }: {
          changedFiles: string[];
          knownFiles: Set<string>;
          removedFiles: string[];
        }): FileChanges => {
          const addedFiles: string[] = [];
          const modifiedFiles: string[] = [];

          for (const file of unique(changedFiles)) {
            if (knownFiles.has(file)) {
              modifiedFiles.push(file);
            } else {
              addedFiles.push(file);
              knownFiles.add(file);
            }
          }

          for (const file of removedFiles) {
            knownFiles.delete(file);
          }

          return {
            addedFiles,
            modifiedFiles,
            removedFiles: unique(removedFiles),
          };
        };

        const hasFileChanges = ({
          addedFiles,
          modifiedFiles,
          removedFiles,
        }: FileChanges) =>
          addedFiles.length > 0 ||
          modifiedFiles.length > 0 ||
          removedFiles.length > 0;
        const logDevHmr = (...args: unknown[]) => {
          if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
            console.log(...args);
          }
        };

        // Known gap: the initial build has the same two-read shape (the
        // combined build above consumed sources, and this refresh re-reads
        // them), but no pinning, and the watcher below attaches with
        // `ignoreInitial: true`, so an edit landing inside the startup window
        // is absorbed with no straggler event to recover it. Bounded by dev
        // server startup rather than recurring per rebuild; knowingly out of
        // scope for the mid-rebuild pinning above.
        await refreshSourceSnapshots();
        let {
          files: knownFiles,
          aliases: knownFileAliases,
          addKnownFile: rememberKnownFile,
        } = await readKnownFiles();

        const refreshKnownFiles = async () => {
          const nextKnown = await readKnownFiles();
          knownFiles = nextKnown.files;
          knownFileAliases = nextKnown.aliases;
          rememberKnownFile = nextKnown.addKnownFile;
        };

        const processFileChanges = async (fileChanges: FileChanges) => {
          if (!hasFileChanges(fileChanges)) {
            return;
          }

          const decision = await classifyRebuild({
            discoveredEntries,
            fileChanges,
            inputFiles: options.inputFiles,
            normalizePath,
            parentHasChild,
            readSnapshot: readSourceSnapshot,
            sourceSnapshots,
          });
          if (decision.kind === 'none') {
            logDevHmr('workflow dev hmr: skip');
            for (const [file, snapshot] of decision.snapshots || []) {
              sourceSnapshots.set(file, snapshot);
            }
            return;
          }
          if (decision.kind === 'full') {
            logDevHmr('workflow dev hmr: full rediscovery');
            try {
              await fullRebuild();
              await refreshKnownFiles();
            } finally {
              // Lets a log reader tell "quiet" from "rebuild in flight".
              // The e2e HMR tests drain-to-quiet before counting lines.
              logDevHmr('workflow dev hmr: rebuild complete');
            }
            return;
          }

          logDevHmr(
            `workflow dev hmr: hot rebuild${decision.refreshStepRegistrations ? ' with step registration refresh' : ''}`
          );
          try {
            await hotRebuild(decision.refreshStepRegistrations);
            for (const [file, snapshot] of decision.snapshots) {
              sourceSnapshots.set(file, snapshot);
            }
          } finally {
            // See the matching line on the full path above.
            logDevHmr('workflow dev hmr: rebuild complete');
          }
        };

        let pendingFileChanges: FileChanges = {
          addedFiles: [],
          modifiedFiles: [],
          removedFiles: [],
        };
        let flushTimer: ReturnType<typeof setTimeout> | undefined;

        const scheduleFileChanges = (fileChanges: FileChanges) => {
          pendingFileChanges = mergeFileChanges(
            pendingFileChanges,
            fileChanges
          );
          if (flushTimer) {
            return;
          }
          flushTimer = setTimeout(() => {
            const fileChanges = pendingFileChanges;
            pendingFileChanges = {
              addedFiles: [],
              modifiedFiles: [],
              removedFiles: [],
            };
            flushTimer = undefined;
            enqueue(() => processFileChanges(fileChanges));
          }, 10);
        };

        const resolveExistingEventPath = async (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const knownPath = knownFileAliases.get(normalizedPath);
          if (knownPath) {
            return knownPath;
          }

          try {
            const realFilePath = normalizePath(await realpath(normalizedPath));
            return knownFileAliases.get(realFilePath) ?? normalizedPath;
          } catch {
            return normalizedPath;
          }
        };

        const handleFileAdded = async (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const existingPath = await resolveExistingEventPath(normalizedPath);
          const wasKnown = existingPath ? knownFiles.has(existingPath) : false;
          const canonicalPath = await rememberKnownFile(normalizedPath);
          knownFiles.add(canonicalPath);
          scheduleFileChanges({
            addedFiles: wasKnown ? [] : [canonicalPath],
            modifiedFiles: wasKnown ? [canonicalPath] : [],
            removedFiles: [],
          });
        };

        const handleFileChanged = async (pathname: string) => {
          const canonicalPath = await resolveExistingEventPath(pathname);
          if (!canonicalPath) {
            return;
          }

          const fileChanges = classifyFileChanges({
            changedFiles: [canonicalPath],
            knownFiles,
            removedFiles: [],
          });
          if (!knownFileAliases.has(canonicalPath)) {
            await rememberKnownFile(canonicalPath);
          }
          scheduleFileChanges(fileChanges);
        };

        const handleFileRemoved = (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const canonicalPath =
            knownFileAliases.get(normalizedPath) ?? normalizedPath;
          const fileChanges = classifyFileChanges({
            changedFiles: [],
            knownFiles,
            removedFiles: [canonicalPath],
          });
          knownFileAliases.delete(normalizedPath);
          scheduleFileChanges(fileChanges);
        };

        const watcher = chokidar.watch(this.config.workingDir, {
          ignoreInitial: true,
          followSymlinks: true,
          ignored: (pathname) => {
            const normalizedPath = normalizePath(String(pathname));
            const extension = extname(normalizedPath);
            if (extension && !watchableExtensions.has(extension)) {
              return true;
            }
            return hasIgnoredPathFragment(normalizedPath);
          },
        });

        watcher.on('add', (pathname) => {
          void handleFileAdded(pathname);
        });
        watcher.on('change', (pathname) => {
          void handleFileChanged(pathname);
        });
        watcher.on('unlink', (pathname) => {
          handleFileRemoved(pathname);
        });
        watcher.on('error', (error) => {
          console.error('Workflow dev watcher error', error);
        });
        watcher.on('ready', () => {
          logDevHmr('workflow dev hmr: ready');
        });
      }
    }

    protected async getInputFiles(): Promise<string[]> {
      const inputFiles = await super.getInputFiles();
      return inputFiles.filter((file) => {
        const entry = relative(this.config.workingDir, file).replaceAll(
          '\\',
          '/'
        );

        // Match App Router route, page, and layout entrypoints in app/ or src/app/.
        if (/^(?:app|src\/app)\/(?:.*\/)?(?:route|page|layout)\./.test(entry)) {
          return true;
        }

        // Match every Pages Router entrypoint in pages/ or src/pages/.
        if (/^(?:pages|src\/pages)\//.test(entry)) {
          return true;
        }

        // Match Next.js root entrypoints at the project root or under src/.
        return ['instrumentation', 'middleware', 'proxy'].some((name) =>
          this.config.pageExtensions.some(
            (extension) =>
              entry === `${name}.${extension}` ||
              entry === `src/${name}.${extension}`
          )
        );
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

      return await this.createCombinedBundle({
        format: 'esm',
        inputFiles,
        stepsOutfile: join(flowRouteDir, '__step_registrations.js'),
        flowOutfile: join(flowRouteDir, 'route.js'),
        bundleFinalOutput: false,
        externalizeNonSteps: true,
        sourceStepRegistrationImports: true,
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
