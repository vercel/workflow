import { constants, type Dirent } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  NextConfig as BuilderNextConfig,
  WorkflowManifest,
} from '@workflow/builders';
import chokidar from 'chokidar';
import type { NextConfig as ProjectNextConfig } from 'next';
import {
  classifyRebuild,
  createSourceSnapshot,
  type FileChanges,
  getRelevantFiles,
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
    WORKFLOW_QUEUE_TRIGGER,
    detectWorkflowPatterns,
    parentHasChild,
  } = buildersModule ??
  (await importEsm<typeof import('@workflow/builders')>('@workflow/builders'));

  class NextBuilder extends BaseBuilderClass {
    protected declare config: BuilderNextConfig & {
      pageExtensions: NonNullable<ProjectNextConfig['pageExtensions']>;
    };

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
          if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
            await writeFile(join(publicManifestDir, '.gitignore'), '*');
          }
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
        let workflowInterimBundleText =
          combinedResult.workflowInterimBundleText;
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

        const hasIgnoredPathFragment = (normalizedPath: string) => {
          if (normalizedPath.startsWith(normalizedGeneratedDir)) {
            return true;
          }
          for (const fragment of ignoredPathFragments) {
            if (normalizedPath.includes(fragment)) {
              return true;
            }
          }
          return false;
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

          workflowInterimBundleText = workflowOutput;
          await workflowsCtx.bundleFinal(workflowOutput);
          await writeManifest(mergeCombinedManifest(stepsManifest));
        };

        const fullRebuild = async () => {
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
          workflowInterimBundleText = newCombined.workflowInterimBundleText;

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
        };

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
        const stepExecutionFilesChanged = (fileChanges: FileChanges) => {
          const stepEntryFiles = [...discoveredEntries.discoveredSteps].map(
            normalizePath
          );
          if (stepEntryFiles.length === 0) {
            return false;
          }
          const changedFiles = unique([
            ...fileChanges.modifiedFiles,
            ...fileChanges.addedFiles,
            ...fileChanges.removedFiles,
          ]).map(normalizePath);

          return changedFiles.some(
            (changedFile) =>
              stepEntryFiles.includes(changedFile) ||
              stepEntryFiles.some((stepFile) =>
                parentHasChild(stepFile, changedFile)
              )
          );
        };
        const logDevHmr = (...args: unknown[]) => {
          if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
            console.log(...args);
          }
        };

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
            if (
              !stepsCtx &&
              workflowInterimBundleText &&
              stepExecutionFilesChanged(fileChanges)
            ) {
              // Source step registrations keep stable imports, so Turbopack
              // can leave the generated flow route cached after a
              // step-body-only edit. Refresh the route wrapper without
              // rediscovering entries or rebuilding the workflow VM.
              await workflowsCtx.bundleFinal(workflowInterimBundleText);
            }
            return;
          }
          if (decision.kind === 'full') {
            logDevHmr('workflow dev hmr: full rediscovery');
            await fullRebuild();
            await refreshKnownFiles();
            return;
          }

          logDevHmr(
            `workflow dev hmr: hot rebuild${decision.refreshStepRegistrations ? ' with step registration refresh' : ''}`
          );
          await hotRebuild(decision.refreshStepRegistrations);
          for (const [file, snapshot] of decision.snapshots) {
            sourceSnapshots.set(file, snapshot);
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
