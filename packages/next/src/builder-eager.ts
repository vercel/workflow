import { constants } from 'node:fs';
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  NextConfig as BuilderNextConfig,
  WorkflowManifest,
} from '@workflow/builders';
import type { NextConfig as ProjectNextConfig } from 'next';
import Watchpack from 'watchpack';
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
import {
  createWatchScope,
  ROOT_ENTRYPOINT_NAMES,
  ROOT_MODULE_EXTENSIONS,
  ROOT_MODULE_NAMES,
} from './watch-scope.js';

let CachedNextBuilderEager: any;
const importEsm = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string
) => Promise<T>;

/**
 * The dev watcher belongs to the process, not to a builder instance. Next.js
 * re-evaluates `next.config` more than once per dev session (on a config edit,
 * and today also on the second evaluation that slips past the build guard), and
 * every evaluation constructs a fresh builder. Without this, each one would
 * leave the previous watcher attached: its handlers keep rebuilding against a
 * module graph nobody is serving, and its directory watches are never released.
 */
let activeDevWatcher: { close(): void } | undefined;

function closeActiveDevWatcher(): void {
  activeDevWatcher?.close();
  activeDevWatcher = undefined;
}

function setActiveDevWatcher(watcher: { close(): void }): void {
  closeActiveDevWatcher();
  activeDevWatcher = watcher;
}

const appEntrypoint =
  /^(?:page|route|layout|default|error|loading|template|not-found|forbidden|unauthorized|sitemap|(?:icon|apple-icon|opengraph-image|twitter-image)\d?)$/;
const appRootEntrypoint = /^(?:global-error|global-not-found|robots|manifest)$/;
// Built from the same lists the watch scope uses, so the set of filenames the
// watcher covers cannot drift from the set discovery treats as entrypoints.
const rootEntrypoint = new RegExp(`^(?:${ROOT_ENTRYPOINT_NAMES.join('|')})$`);
const rootModuleEntrypoint = new RegExp(
  `^(?:${ROOT_MODULE_NAMES.join('|')})\\.(?:${ROOT_MODULE_EXTENSIONS.join('|')})$`
);

export function createNextEntrypointMatcher(pageExtensions: readonly string[]) {
  const extensions = [...pageExtensions].sort((a, b) => b.length - a.length);

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
      if (this.config.watch) {
        // Detach before the rebuild rather than after it, so a watcher from a
        // previous config evaluation cannot queue rebuilds against the build
        // that is about to replace it.
        closeActiveDevWatcher();
      }

      // Marks the content this build is about to read. The watcher attaches
      // with it so an edit that lands while the build runs is not lost to the
      // gap between reading a file and watching it.
      const buildStartedAt = Date.now();
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

        // Prune ignored trees out of the watch set, so the recursive route-root
        // watches below never descend into `node_modules`, the build output or
        // anything `.gitignore` covers. This honors `.gitignore` and the
        // WORKFLOW_DEV_WATCH_IGNORED_PATHS env var in addition to the
        // built-in fragments. The generated workflow dir is passed as an
        // extra fragment so it is pruned regardless of `.gitignore`: the
        // builder writes into it, and watching it would rebuild in a loop.
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

        const logDevHmr = (...args: unknown[]) => {
          if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
            console.log(...args);
          }
        };

        const isNextEntrypoint = createNextEntrypointMatcher(
          this.config.pageExtensions
        );
        const isNextEntrypointPath = (file: string) => {
          const entry = relative(this.config.workingDir, file).replaceAll(
            '\\',
            '/'
          );
          if (entry.startsWith('../')) {
            return false;
          }
          return isNextEntrypoint(entry);
        };

        // Watch the framework's module graph, not the project tree.
        //
        // Two things go wrong when the watcher is pointed at `workingDir`.
        // chokidar registers an `fs.watch` per *file* it walks into, and on
        // macOS libuv only routes a *directory* watch through FSEvents: a
        // regular-file watch falls back to kqueue, which holds a descriptor for
        // as long as the watch is open. A large app therefore accumulated one
        // descriptor per source file until it reached the per-process limit,
        // after which unrelated `fork()` calls started failing with
        // `spawn EBADF`. And a file the app never imports cannot change a
        // bundle, so every event outside the graph was work the classifier paid
        // for and then discarded.
        //
        // Watchpack never watches a file directly (its own words: "Files are
        // never watched directly"); it derives file events from the parent
        // directory. The descriptor cost becomes O(watched directories) rather
        // than O(source files), and directory watches are exactly what FSEvents
        // handles well. It coalesces those directory watches into recursive
        // watchers only where the OS implements recursion natively (macOS,
        // Windows), and stays on plain per-directory watches on Linux. It is
        // also the watcher Next.js itself runs, so a dev server does not gain a
        // second watching strategy with its own ideas about polling.
        const watcher = new Watchpack({
          // A linked source file is watched through the directory holding the
          // *link*, which never sees a write to the target. Resolving the chain
          // watches both ends and still reports the path the graph knows the
          // file by. Apps that symlink sources into place (this repo's own
          // workbench among them) depend on it.
          followSymlinks: true,
          ignored: (pathname: string) =>
            hasIgnoredPathFragment(normalizePath(pathname)),
        });
        setActiveDevWatcher(watcher);

        /**
         * Attach the watcher to the scope the current graph implies.
         *
         * `startTime` has to predate the reads that produced that graph rather
         * than be "now". Discovery is what decides a file belongs to the graph,
         * so a file only joins the watch set at the *end* of the build that
         * found it — after that build published its manifest. An edit landing
         * in between would otherwise be watched by nobody and lost. Watchpack
         * replays it instead: a path attaching for the first time whose
         * recorded mtime is at or after `startTime` gets a synthetic change
         * ("watching can be started in the past"). Replays for content the
         * build already consumed diff equal against the pinned baseline and
         * classify as a no-op, so the cost of reaching back is a skip.
         */
        const applyWatchScope = (startTime: number) => {
          const scope = createWatchScope({
            workingDir: normalizePath(this.config.workingDir),
            relevantFiles: getRelevantFiles({
              discoveredEntries,
              inputFiles: options.inputFiles,
              normalizePath,
            }),
            pageExtensions: this.config.pageExtensions,
            isIgnored: hasIgnoredPathFragment,
          });

          watcher.watch({ ...scope, startTime });
          logDevHmr(
            `workflow dev hmr: watching ${scope.files.length} graph files and ${scope.directories.length} entrypoint roots`
          );
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
          const workflowOutput = workflowResult.outputFiles?.[0]?.text;
          if (!workflowOutput) {
            throw new Error(
              'Invariant: expected workflow output from hot rebuild'
            );
          }

          await workflowsCtx.bundleFinal(workflowOutput);
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

        /**
         * The set of files the classifier has already seen, which is what
         * separates "this file was edited" from "this file just appeared".
         *
         * It is seeded from the module graph rather than from a walk of the
         * project tree: the graph is what the build consumed, it is what the
         * watcher tracks, and reading it costs nothing on top of the discovery
         * that already ran. Anything the route-root watches surface later is
         * added on its first event.
         */
        const seedKnownFiles = () => {
          const relevantFiles = getRelevantFiles({
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
          });
          const files = new Set(relevantFiles);
          const aliases = new Map<string, string>();
          for (const file of files) {
            aliases.set(file, file);
          }

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

        // Known gap: the initial build has the same two-read shape (the
        // combined build above consumed sources, and this refresh re-reads
        // them), but no pinning. The watcher does reach back over the build
        // window, so an edit landing there produces an event — but this refresh
        // has already absorbed that edit into the baseline, so the event
        // classifies as a no-op and the build keeps the content it read.
        // Bounded by dev server startup rather than recurring per rebuild;
        // knowingly out of scope for the mid-rebuild pinning above.
        await refreshSourceSnapshots();
        let {
          files: knownFiles,
          aliases: knownFileAliases,
          addKnownFile: rememberKnownFile,
        } = seedKnownFiles();

        const refreshKnownFiles = () => {
          const nextKnown = seedKnownFiles();
          knownFiles = nextKnown.files;
          knownFileAliases = nextKnown.aliases;
          rememberKnownFile = nextKnown.addKnownFile;
        };

        const processFileChanges = async (fileChanges: FileChanges) => {
          if (!hasFileChanges(fileChanges)) {
            return;
          }

          // Taken before anything reads a source file, so a rescope at the end
          // still reaches back over every read this batch is about to do.
          const batchStartedAt = Date.now();
          const decision = await classifyRebuild({
            discoveredEntries,
            fileChanges,
            inputFiles: options.inputFiles,
            isEntrypoint: isNextEntrypointPath,
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
              refreshKnownFiles();
              // Rediscovery is what moves files in and out of the graph, so the
              // watch set is only correct once it follows.
              applyWatchScope(batchStartedAt);
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

        // Covers creation as well as modification: `classifyFileChanges` sorts
        // the two apart by whether the path is already known.
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

        watcher.on('change', (pathname: string, mtime: number | null) => {
          // A file deleted from inside a watched directory tree arrives as a
          // change with no mtime. Watchpack reserves `remove` for paths it was
          // handed individually, which here means the graph files.
          if (mtime === null) {
            handleFileRemoved(pathname);
            return;
          }
          void handleFileChanged(pathname);
        });
        watcher.on('remove', (pathname: string) => {
          handleFileRemoved(pathname);
        });

        applyWatchScope(buildStartedAt);
        logDevHmr('workflow dev hmr: ready');
      }
    }

    protected async getInputFiles(): Promise<string[]> {
      const inputFiles = await super.getInputFiles();
      const isNextEntrypoint = createNextEntrypointMatcher(
        this.config.pageExtensions
      );
      const inputFileSet = new Set(inputFiles);
      const rootModuleFiles = new Set(
        ROOT_MODULE_NAMES.flatMap((name) => {
          const file = ['src', '']
            .flatMap((directory) =>
              ROOT_MODULE_EXTENSIONS.map((extension) =>
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
        if (rootModuleEntrypoint.test(rootModule)) {
          return rootModuleFiles.has(file);
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
