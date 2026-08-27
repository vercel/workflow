import assert from 'node:assert';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type {
  NextConfig as BuilderNextConfig,
  WorkflowManifest,
} from '@workflow/builders';
import chokidar from 'chokidar';
import type { NextConfig as ProjectNextConfig } from 'next';
import { findDir, findPagesDir } from 'next/dist/lib/find-pages-dir';
import { recursiveReadDir } from 'next/dist/lib/recursive-readdir';
import { createValidFileMatcher } from 'next/dist/server/lib/find-page-file';
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

const appConventionNames = [
  'error',
  'loading',
  'template',
  'not-found',
  'forbidden',
  'unauthorized',
] as const;
const appRootConventionNames = ['global-error', 'global-not-found'] as const;
const rootConventionNames = [
  'instrumentation',
  'instrumentation-client',
  'middleware',
  'proxy',
] as const;
const mdxComponentsFile = /^mdx-components\.[jt]sx?$/;

export async function findNextEntrypoints({
  workingDir,
  pageExtensions,
}: {
  workingDir: string;
  pageExtensions: string[];
}): Promise<string[]> {
  const { appDir, pagesDir } = findPagesDir(workingDir);
  const routerDir = pagesDir ?? appDir;
  assert(routerDir);

  const rootDir = dirname(routerDir);
  const validFileMatcher = createValidFileMatcher(pageExtensions, appDir);
  const extensionSuffixes = pageExtensions.map((extension) => `.${extension}`);
  const conventionFiles = (names: readonly string[]) =>
    new Set(
      names.flatMap((name) =>
        pageExtensions.map((extension) => `${name}.${extension}`)
      )
    );
  const appConventionFiles = conventionFiles(appConventionNames);
  const appRootConventionFiles = conventionFiles(appRootConventionNames);
  const rootConventionFiles = conventionFiles(rootConventionNames);

  const relativeTo = (directory: string, file: string) => {
    const entry = relative(directory, file).replaceAll('\\', '/');
    if (entry === '..' || entry.startsWith('../') || isAbsolute(entry)) {
      return undefined;
    }
    return entry;
  };

  const isAppEntrypoint = (file: string, filename: string) => {
    assert(appDir);
    const appEntry = relativeTo(appDir, file);
    if (appEntry === undefined) return false;
    if (!appEntry.includes('/') && appRootConventionFiles.has(filename)) {
      return true;
    }
    return (
      validFileMatcher.isAppRouterPage(file) ||
      validFileMatcher.isAppLayoutPage(file) ||
      validFileMatcher.isAppDefaultPage(file) ||
      appConventionFiles.has(filename)
    );
  };

  const isEntrypoint = (file: string) => {
    if (file.endsWith('.d.ts')) return false;

    const filename = basename(file);
    if (dirname(file) === rootDir) {
      return (
        mdxComponentsFile.test(filename) || rootConventionFiles.has(filename)
      );
    }

    const hasPageExtension = extensionSuffixes.some((extension) =>
      file.endsWith(extension)
    );
    if (!hasPageExtension) return false;

    if (pagesDir && relativeTo(pagesDir, file) !== undefined) {
      return validFileMatcher.isPageFile(file);
    }

    return appDir ? isAppEntrypoint(file, filename) : false;
  };

  const [appFiles, pagesFiles, rootEntries] = await Promise.all([
    appDir
      ? recursiveReadDir(appDir, {
          pathnameFilter: isEntrypoint,
          ignorePartFilter: (part) => part.startsWith('_'),
          ignoreFilter: (pathname) =>
            pathname === join(appDir, '.well-known/workflow'),
          relativePathnames: false,
        })
      : [],
    pagesDir
      ? recursiveReadDir(pagesDir, {
          pathnameFilter: isEntrypoint,
          relativePathnames: false,
        })
      : [],
    readdir(rootDir, { withFileTypes: true }),
  ]);
  const rootFiles = rootEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(rootDir, entry.name))
    .filter(isEntrypoint);

  return [...appFiles, ...pagesFiles, ...rootFiles].sort();
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
          ...this.config.pageExtensions.map((extension) =>
            extname(`file.${extension}`)
          ),
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
      return findNextEntrypoints({
        workingDir: this.config.workingDir,
        pageExtensions: this.config.pageExtensions,
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
      const appDir = findDir(this.config.workingDir, 'app');
      if (appDir) return appDir;

      const pagesDir = findDir(this.config.workingDir, 'pages');
      if (pagesDir) {
        const outputDir = join(dirname(pagesDir), 'app');
        await mkdir(outputDir, { recursive: true });
        return outputDir;
      }

      throw new Error(
        'Could not find Next.js app or pages directory. Expected one of: "app", "src/app", "pages", or "src/pages" to exist.'
      );
    }
  }

  CachedNextBuilderEager = NextBuilder;
  return NextBuilder;
}
