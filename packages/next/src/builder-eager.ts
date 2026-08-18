import { constants, type Dirent } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  realpath,
  rm,
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
import { createWatchIgnorePredicate } from './watch-ignore.js';
import {
  classifyRebuild,
  createRebuildScheduler,
  createSourceSnapshot,
  getRelevantFiles,
  readSourceSnapshots,
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
        let sourceSnapshots = new Map<string, SourceSnapshot>();

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

        const readSourceSnapshot = (file: string) =>
          createSourceSnapshot({ file, detectWorkflowPatterns });

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

        const fullRebuild = async (
          triggerSnapshots?: Map<string, SourceSnapshot>
        ) => {
          this.clearDiscoveredEntriesCache();
          const newInputFiles = await this.getInputFiles();
          options.inputFiles = newInputFiles;

          // Snapshot before building so edits made during the build remain
          // dirty and trigger the file event already queued behind this task.
          const nextSourceSnapshots = await snapshotSources();

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
          // Files this rebuild discovered for the first time are absent from
          // the pre-build capture (it read the previous graph's relevant
          // set). Seed them from what the classifier read when it decided on
          // this rediscovery, so a freshly created file's routine duplicate
          // events diff equal instead of forcing another rebuild, while a
          // mid-build edit still diffs as changed. Files the capture did read
          // keep the captured value: it is closer to what the build consumed.
          for (const [file, snapshot] of triggerSnapshots ?? []) {
            if (!nextSourceSnapshots.has(file)) {
              nextSourceSnapshots.set(file, snapshot);
            }
          }
          sourceSnapshots = nextSourceSnapshots;
        };

        const isWatchableFile = (path: string) =>
          watchableExtensions.has(extname(path));

        const readKnownFileAliases = async () => {
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
          return { aliases, addKnownFile };
        };

        const logDevHmr = (...args: unknown[]) => {
          if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
            console.log(...args);
          }
        };

        sourceSnapshots = await snapshotSources();
        let { aliases: knownFileAliases, addKnownFile: rememberKnownFile } =
          await readKnownFileAliases();

        const refreshKnownFiles = async () => {
          const nextKnown = await readKnownFileAliases();
          knownFileAliases = nextKnown.aliases;
          rememberKnownFile = nextKnown.addKnownFile;
        };

        const runFullRebuild = async (
          triggerSnapshots?: Map<string, SourceSnapshot>
        ) => {
          logDevHmr('workflow dev hmr: full rediscovery');
          await fullRebuild(triggerSnapshots);
          await refreshKnownFiles();
        };

        const processFileChanges = async (files: string[]) => {
          const decision = await classifyRebuild({
            files,
            discoveredEntries,
            inputFiles: options.inputFiles,
            normalizePath,
            parentHasChild,
            readSnapshot: readSourceSnapshot,
            sourceSnapshots,
          });
          switch (decision.kind) {
            // A repeated notification for a write that was already consumed:
            // nothing changed and nothing was rebuilt. Logged under its own
            // marker (not `skip`) so the e2e HMR log-count assertions can
            // stay exact for the events that had an effect.
            case 'duplicate':
              logDevHmr('workflow dev hmr: duplicate');
              return;
            case 'skip':
              logDevHmr('workflow dev hmr: skip');
              break;
            case 'hot':
              logDevHmr(
                `workflow dev hmr: hot rebuild${decision.refreshStepRegistrations ? ' with step registration refresh' : ''}`
              );
              await hotRebuild(decision.refreshStepRegistrations);
              break;
            case 'full':
              await runFullRebuild(decision.snapshots);
              return;
            default:
              decision satisfies never;
              throw new Error('Unknown rebuild decision');
          }
          sourceSnapshots = new Map([
            ...sourceSnapshots,
            ...decision.snapshots,
          ]);
        };

        const scheduleRebuild = createRebuildScheduler(
          async (request) => {
            try {
              switch (request.kind) {
                case 'files':
                  await processFileChanges(request.files);
                  return;
                case 'full':
                  await runFullRebuild();
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
        const scheduleFileChange = (file: string) => {
          scheduleRebuild({ kind: 'files', files: [file] });
        };

        const handleFileWritten = async (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const canonicalPath =
            knownFileAliases.get(normalizedPath) ??
            (await rememberKnownFile(normalizedPath));
          scheduleFileChange(canonicalPath);
        };

        const handleFileRemoved = (pathname: string) => {
          const normalizedPath = normalizePath(pathname);
          if (!isWatchableFile(normalizedPath)) {
            return;
          }

          const canonicalPath =
            knownFileAliases.get(normalizedPath) ?? normalizedPath;
          knownFileAliases.delete(normalizedPath);
          scheduleFileChange(canonicalPath);
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

        // Events that land while a rebuild runs are not special-cased: the
        // scheduled dirty path is classified after the build finishes against
        // the baseline the build consumed, so a real mid-build edit diffs as
        // changed, a duplicate notification diffs as the same write and is
        // suppressed, and a same-content rewrite (whose interim states the
        // build may have consumed) diffs as a rewrite and stays a
        // conservative rediscovery.
        watcher.on('add', (pathname) => {
          void handleFileWritten(pathname);
        });
        watcher.on('change', (pathname) => {
          void handleFileWritten(pathname);
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
