import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  createSocketServer,
  type SocketIO,
  type SocketServerConfig,
} from './socket-server.js';
import {
  createDeferredStepCopyInlineSourceMapComment,
  createDeferredStepSourceMetadataComment,
  DEFERRED_STEP_COPY_DIR_NAME,
} from './step-copy-utils.js';

const ROUTE_STUB_FILE_MARKER = 'WORKFLOW_ROUTE_STUB_FILE';

type WorkflowManifest = import('@workflow/builders').WorkflowManifest;

interface DeferredDiscoveredEntries {
  discoveredSteps: string[];
  discoveredWorkflows: string[];
  discoveredSerdeFiles: string[];
}

let CachedNextBuilderDeferred: any;

// Create the deferred Next builder dynamically by extending the ESM BaseBuilder.
// Exported as getNextBuilderDeferred() to allow CommonJS modules to import from
// the ESM @workflow/builders package via dynamic import at runtime.
export async function getNextBuilderDeferred() {
  if (CachedNextBuilderDeferred) {
    return CachedNextBuilderDeferred;
  }

  const {
    BaseBuilder: BaseBuilderClass,
    STEP_QUEUE_TRIGGER,
    WORKFLOW_QUEUE_TRIGGER,
    applySwcTransform,
    detectWorkflowPatterns,
    getImportPath,
    isWorkflowSdkFile,
    resolveWorkflowAliasRelativePath,
    // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript from transpiling the import statement into `require()`
  } = (await eval(
    'import("@workflow/builders")'
  )) as typeof import('@workflow/builders');

  class NextDeferredBuilder extends BaseBuilderClass {
    private socketIO?: SocketIO;
    private readonly discoveredWorkflowFiles = new Set<string>();
    private readonly discoveredStepFiles = new Set<string>();
    private readonly discoveredSerdeFiles = new Set<string>();
    private trackedDependencyFiles = new Set<string>();
    private deferredBuildQueue = Promise.resolve();
    private cacheInitialized = false;
    private cacheWriteTimer: NodeJS.Timeout | null = null;
    private lastDeferredBuildSignature: string | null = null;

    async build() {
      const outputDir = await this.findAppDirectory();

      await this.initializeDiscoveryState();
      await this.cleanupGeneratedArtifactsOnBoot(outputDir);

      await this.writeStubFiles(outputDir);
      await this.createDiscoverySocketServer();
    }

    async onBeforeDeferredEntries(): Promise<void> {
      await this.initializeDiscoveryState();
      await this.validateDiscoveredEntryFiles();
      const implicitStepFiles = await this.resolveImplicitStepFiles();

      const pendingBuild = this.deferredBuildQueue.then(() =>
        this.buildDeferredEntriesUntilStable(implicitStepFiles)
      );

      // Keep the queue chain alive even when the current build fails so future
      // callbacks can enqueue another attempt without triggering unhandled
      // rejection warnings.
      this.deferredBuildQueue = pendingBuild.catch(() => {
        // Error is surfaced through `pendingBuild` below.
      });

      await pendingBuild;
    }

    private getCurrentInputFiles(implicitStepFiles: string[]): string[] {
      return Array.from(
        new Set([
          ...this.discoveredWorkflowFiles,
          ...this.discoveredStepFiles,
          ...this.discoveredSerdeFiles,
          ...implicitStepFiles,
        ])
      ).sort();
    }

    private async buildDeferredEntriesUntilStable(
      implicitStepFiles: string[]
    ): Promise<void> {
      // A successful build can discover additional transitive dependency files
      // (via source maps), which changes the signature and may require one more
      // build pass to include newly discovered serde files.
      const maxBuildPasses = 3;

      for (let buildPass = 0; buildPass < maxBuildPasses; buildPass++) {
        const inputFiles = this.getCurrentInputFiles(implicitStepFiles);
        const buildSignature =
          await this.createDeferredBuildSignature(inputFiles);
        if (buildSignature === this.lastDeferredBuildSignature) {
          return;
        }

        let didBuildSucceed = false;
        try {
          await this.buildDiscoveredFiles(inputFiles, implicitStepFiles);
          didBuildSucceed = true;
        } catch (error) {
          if (this.config.watch) {
            console.warn(
              '[workflow] Deferred entries build failed. Will retry only after inputs change.',
              error
            );
          } else {
            throw error;
          }
        } finally {
          // Record attempted signature even on failure so we don't loop on the
          // same broken input graph.
          this.lastDeferredBuildSignature = buildSignature;
        }

        if (!didBuildSucceed) {
          return;
        }

        const postBuildInputFiles =
          this.getCurrentInputFiles(implicitStepFiles);
        const postBuildSignature =
          await this.createDeferredBuildSignature(postBuildInputFiles);
        if (postBuildSignature === buildSignature) {
          return;
        }
      }

      console.warn(
        '[workflow] Deferred entries build signature did not stabilize after 3 passes.'
      );
    }

    private async resolveImplicitStepFiles(): Promise<string[]> {
      let workflowCjsEntry: string;
      try {
        workflowCjsEntry = require.resolve('workflow', {
          paths: [this.config.workingDir],
        });
      } catch {
        return [];
      }

      const workflowDistDir = dirname(workflowCjsEntry);
      const workflowStdlibPath = this.normalizeDiscoveredFilePath(
        join(workflowDistDir, 'stdlib.js')
      );

      const candidatePaths = [workflowStdlibPath];
      const existingFiles = await Promise.all(
        candidatePaths.map(async (filePath) => {
          try {
            const fileStats = await stat(filePath);
            return fileStats.isFile() ? filePath : null;
          } catch {
            return null;
          }
        })
      );

      return existingFiles.filter((filePath): filePath is string =>
        Boolean(filePath)
      );
    }

    private areFileSetsEqual(a: Set<string>, b: Set<string>): boolean {
      if (a.size !== b.size) {
        return false;
      }

      for (const filePath of a) {
        if (!b.has(filePath)) {
          return false;
        }
      }

      return true;
    }

    private async reconcileDiscoveredEntries({
      workflowCandidates,
      stepCandidates,
      serdeCandidates,
      validatePatterns,
    }: {
      workflowCandidates: Iterable<string>;
      stepCandidates: Iterable<string>;
      serdeCandidates?: Iterable<string>;
      validatePatterns: boolean;
    }): Promise<{
      workflowFiles: Set<string>;
      stepFiles: Set<string>;
      serdeFiles: Set<string>;
    }> {
      const candidatesByFile = new Map<
        string,
        {
          hasWorkflowCandidate: boolean;
          hasStepCandidate: boolean;
          hasSerdeCandidate: boolean;
        }
      >();

      for (const filePath of workflowCandidates) {
        const normalizedPath = this.normalizeDiscoveredFilePath(filePath);
        const existing = candidatesByFile.get(normalizedPath);
        if (existing) {
          existing.hasWorkflowCandidate = true;
        } else {
          candidatesByFile.set(normalizedPath, {
            hasWorkflowCandidate: true,
            hasStepCandidate: false,
            hasSerdeCandidate: false,
          });
        }
      }

      for (const filePath of stepCandidates) {
        const normalizedPath = this.normalizeDiscoveredFilePath(filePath);
        const existing = candidatesByFile.get(normalizedPath);
        if (existing) {
          existing.hasStepCandidate = true;
        } else {
          candidatesByFile.set(normalizedPath, {
            hasWorkflowCandidate: false,
            hasStepCandidate: true,
            hasSerdeCandidate: false,
          });
        }
      }

      if (serdeCandidates) {
        for (const filePath of serdeCandidates) {
          const normalizedPath = this.normalizeDiscoveredFilePath(filePath);
          const existing = candidatesByFile.get(normalizedPath);
          if (existing) {
            existing.hasSerdeCandidate = true;
          } else {
            candidatesByFile.set(normalizedPath, {
              hasWorkflowCandidate: false,
              hasStepCandidate: false,
              hasSerdeCandidate: true,
            });
          }
        }
      }

      const fileEntries = Array.from(candidatesByFile.entries()).sort(
        ([a], [b]) => a.localeCompare(b)
      );
      const validatedEntries = await Promise.all(
        fileEntries.map(async ([filePath, candidates]) => {
          try {
            const fileStats = await stat(filePath);
            if (!fileStats.isFile()) {
              return null;
            }

            if (!validatePatterns) {
              const isSdkFile = isWorkflowSdkFile(filePath);
              return {
                filePath,
                hasUseWorkflow: candidates.hasWorkflowCandidate,
                hasUseStep: candidates.hasStepCandidate,
                hasSerde: candidates.hasSerdeCandidate && !isSdkFile,
              };
            }

            const source = await readFile(filePath, 'utf-8');
            const patterns = detectWorkflowPatterns(source);
            const isSdkFile = isWorkflowSdkFile(filePath);
            return {
              filePath,
              hasUseWorkflow: patterns.hasUseWorkflow,
              hasUseStep: patterns.hasUseStep,
              hasSerde: patterns.hasSerde && !isSdkFile,
            };
          } catch {
            return null;
          }
        })
      );

      const workflowFiles = new Set<string>();
      const stepFiles = new Set<string>();
      const serdeFiles = new Set<string>();
      for (const entry of validatedEntries) {
        if (!entry) {
          continue;
        }
        if (entry.hasUseWorkflow) {
          workflowFiles.add(entry.filePath);
        }
        if (entry.hasUseStep) {
          stepFiles.add(entry.filePath);
        }
        if (entry.hasSerde) {
          serdeFiles.add(entry.filePath);
        }
      }

      return { workflowFiles, stepFiles, serdeFiles };
    }

    private async validateDiscoveredEntryFiles(): Promise<void> {
      const { workflowFiles, stepFiles, serdeFiles } =
        await this.reconcileDiscoveredEntries({
          workflowCandidates: this.discoveredWorkflowFiles,
          stepCandidates: this.discoveredStepFiles,
          serdeCandidates: this.discoveredSerdeFiles,
          validatePatterns: true,
        });
      const workflowsChanged = !this.areFileSetsEqual(
        this.discoveredWorkflowFiles,
        workflowFiles
      );
      const stepsChanged = !this.areFileSetsEqual(
        this.discoveredStepFiles,
        stepFiles
      );
      const serdeChanged = !this.areFileSetsEqual(
        this.discoveredSerdeFiles,
        serdeFiles
      );

      if (workflowsChanged || stepsChanged || serdeChanged) {
        this.discoveredWorkflowFiles.clear();
        this.discoveredStepFiles.clear();
        this.discoveredSerdeFiles.clear();
        for (const filePath of workflowFiles) {
          this.discoveredWorkflowFiles.add(filePath);
        }
        for (const filePath of stepFiles) {
          this.discoveredStepFiles.add(filePath);
        }
        for (const filePath of serdeFiles) {
          this.discoveredSerdeFiles.add(filePath);
        }
      }

      if (workflowsChanged || stepsChanged) {
        this.scheduleWorkflowsCacheWrite();
      }
    }

    private async buildDiscoveredFiles(
      inputFiles: string[],
      implicitStepFiles: string[]
    ) {
      const outputDir = await this.findAppDirectory();
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');
      const cacheDir = join(this.config.workingDir, this.getDistDir(), 'cache');
      await mkdir(cacheDir, { recursive: true });
      const manifestBuildDir = join(cacheDir, 'workflow-generated-manifest');
      const tempRouteFileName = 'route.js.temp';
      const trackedDiscoveredEntries =
        await this.collectTrackedDiscoveredEntries();
      const discoveredStepFiles = Array.from(
        new Set([
          ...this.discoveredStepFiles,
          ...trackedDiscoveredEntries.discoveredSteps,
          ...implicitStepFiles,
        ])
      ).sort();
      const discoveredWorkflowFiles = Array.from(
        new Set([
          ...this.discoveredWorkflowFiles,
          ...trackedDiscoveredEntries.discoveredWorkflows,
        ])
      ).sort();
      const discoveredSerdeFileCandidates = Array.from(
        new Set([
          ...this.discoveredSerdeFiles,
          ...trackedDiscoveredEntries.discoveredSerdeFiles,
        ])
      ).sort();
      const discoveredSerdeFiles = await this.collectTransitiveSerdeFiles({
        entryFiles: [...discoveredStepFiles, ...discoveredWorkflowFiles],
        serdeFiles: discoveredSerdeFileCandidates,
      });
      const discoveredEntries = {
        discoveredSteps: discoveredStepFiles,
        discoveredWorkflows: discoveredWorkflowFiles,
        discoveredSerdeFiles,
      };
      const buildInputFiles = Array.from(
        new Set([
          ...inputFiles,
          ...discoveredStepFiles,
          ...discoveredWorkflowFiles,
          ...discoveredSerdeFiles,
        ])
      ).sort();

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });

      await this.writeFileIfChanged(
        join(workflowGeneratedDir, '.gitignore'),
        '*'
      );

      const tsconfigPath = await this.findTsConfigPath();

      const options = {
        inputFiles: buildInputFiles,
        workflowGeneratedDir,
        tsconfigPath,
        routeFileName: tempRouteFileName,
        discoveredEntries,
      };

      const { manifest: stepsManifest } =
        await this.buildStepsFunction(options);
      const workflowsBundle = await this.buildWorkflowsFunction(options);
      await this.buildWebhookRoute({
        workflowGeneratedDir,
        routeFileName: tempRouteFileName,
      });
      await this.refreshTrackedDependencyFiles(
        workflowGeneratedDir,
        tempRouteFileName
      );

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

      const manifestFilePath = join(workflowGeneratedDir, 'manifest.json');
      const manifestBuildPath = join(manifestBuildDir, 'manifest.json');
      const workflowBundlePath = join(
        workflowGeneratedDir,
        `flow/${tempRouteFileName}`
      );
      const manifestJson = await this.createManifest({
        workflowBundlePath,
        manifestDir: manifestBuildDir,
        manifest,
      });
      if (manifestJson) {
        await this.rewriteJsonFileWithStableKeyOrder(manifestBuildPath);
        await this.copyFileIfChanged(manifestBuildPath, manifestFilePath);
      } else {
        await rm(manifestBuildPath, { force: true });
        await rm(manifestFilePath, { force: true });
      }

      await this.writeFunctionsConfig(outputDir);

      await this.copyFileIfChanged(
        join(workflowGeneratedDir, `flow/${tempRouteFileName}`),
        join(workflowGeneratedDir, 'flow/route.js')
      );
      await this.copyFileIfChanged(
        join(workflowGeneratedDir, `step/${tempRouteFileName}`),
        join(workflowGeneratedDir, 'step/route.js')
      );
      await this.copyFileIfChanged(
        join(workflowGeneratedDir, `webhook/[token]/${tempRouteFileName}`),
        join(workflowGeneratedDir, 'webhook/[token]/route.js')
      );

      // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
      // Next.js serves files from public/ at the root URL.
      if (this.shouldExposePublicManifest && manifestJson) {
        const publicManifestDir = join(
          this.config.workingDir,
          'public/.well-known/workflow/v1'
        );
        await mkdir(publicManifestDir, { recursive: true });
        await this.copyFileIfChanged(
          manifestFilePath,
          join(publicManifestDir, 'manifest.json')
        );
      }

      // Notify deferred entry loaders waiting on route.js stubs.
      this.socketIO?.emit('build-complete');
    }

    private async cleanupGeneratedArtifactsOnBoot(
      outputDir: string
    ): Promise<void> {
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');
      const flowRouteDir = join(workflowGeneratedDir, 'flow');
      const stepRouteDir = join(workflowGeneratedDir, 'step');
      const webhookRouteDir = join(workflowGeneratedDir, 'webhook/[token]');

      const staleArtifactPaths = [
        join(flowRouteDir, 'route.js.temp'),
        join(flowRouteDir, 'route.js.temp.debug.json'),
        join(flowRouteDir, 'route.js.debug.json'),
        join(stepRouteDir, 'route.js.temp'),
        join(stepRouteDir, 'route.js.temp.debug.json'),
        join(stepRouteDir, 'route.js.debug.json'),
        join(stepRouteDir, DEFERRED_STEP_COPY_DIR_NAME),
        join(webhookRouteDir, 'route.js.temp'),
        join(workflowGeneratedDir, 'manifest.json'),
      ];

      await Promise.all(
        staleArtifactPaths.map((stalePath) =>
          rm(stalePath, { recursive: true, force: true })
        )
      );

      await Promise.all([
        this.removeStaleDeferredTempFiles(flowRouteDir),
        this.removeStaleDeferredTempFiles(stepRouteDir),
        this.removeStaleDeferredTempFiles(webhookRouteDir),
      ]);
    }

    private async removeStaleDeferredTempFiles(
      routeDir: string
    ): Promise<void> {
      const routeEntries = await readdir(routeDir, {
        withFileTypes: true,
      }).catch(() => []);
      await Promise.all(
        routeEntries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.startsWith('route.js.') &&
              entry.name.endsWith('.tmp')
          )
          .map((entry) =>
            rm(join(routeDir, entry.name), {
              force: true,
            })
          )
      );
    }

    private async createDiscoverySocketServer(): Promise<void> {
      if (this.socketIO || process.env.WORKFLOW_SOCKET_PORT) {
        return;
      }

      const config: SocketServerConfig = {
        isDevServer: Boolean(this.config.watch),
        onFileDiscovered: (
          filePath: string,
          hasWorkflow: boolean,
          hasStep: boolean,
          hasSerde: boolean
        ) => {
          const normalizedFilePath = this.normalizeDiscoveredFilePath(filePath);
          let hasCacheTrackingChange = false;

          if (hasWorkflow) {
            if (!this.discoveredWorkflowFiles.has(normalizedFilePath)) {
              this.discoveredWorkflowFiles.add(normalizedFilePath);
              hasCacheTrackingChange = true;
            }
          } else {
            const wasDeleted =
              this.discoveredWorkflowFiles.delete(normalizedFilePath);
            hasCacheTrackingChange = wasDeleted || hasCacheTrackingChange;
          }

          if (hasStep) {
            if (!this.discoveredStepFiles.has(normalizedFilePath)) {
              this.discoveredStepFiles.add(normalizedFilePath);
              hasCacheTrackingChange = true;
            }
          } else {
            const wasDeleted =
              this.discoveredStepFiles.delete(normalizedFilePath);
            hasCacheTrackingChange = wasDeleted || hasCacheTrackingChange;
          }

          if (hasSerde) {
            this.discoveredSerdeFiles.add(normalizedFilePath);
          } else {
            this.discoveredSerdeFiles.delete(normalizedFilePath);
          }

          if (hasCacheTrackingChange) {
            this.scheduleWorkflowsCacheWrite();
          }
        },
        onTriggerBuild: () => {
          // Deferred builder builds via onBeforeDeferredEntries callback.
        },
      };

      this.socketIO = await createSocketServer(config);
    }

    private async initializeDiscoveryState(): Promise<void> {
      if (this.cacheInitialized) {
        return;
      }

      await this.loadWorkflowsCache();
      this.cacheInitialized = true;
    }

    private getDistDir(): string {
      return (this.config as { distDir?: string }).distDir || '.next';
    }

    private getWorkflowsCacheFilePath(): string {
      return join(
        this.config.workingDir,
        this.getDistDir(),
        'cache',
        'workflows.json'
      );
    }

    private normalizeDiscoveredFilePath(filePath: string): string {
      return isAbsolute(filePath)
        ? filePath
        : resolve(this.config.workingDir, filePath);
    }

    private async createDeferredBuildSignature(
      inputFiles: string[]
    ): Promise<string> {
      const normalizedFiles = Array.from(
        new Set([
          ...inputFiles.map((filePath) =>
            this.normalizeDiscoveredFilePath(filePath)
          ),
          ...this.trackedDependencyFiles,
        ])
      ).sort();

      const signatureParts = await Promise.all(
        normalizedFiles.map(async (filePath) => {
          try {
            const fileStats = await stat(filePath);
            return `${filePath}:${fileStats.size}:${Math.trunc(fileStats.mtimeMs)}`;
          } catch {
            return `${filePath}:missing`;
          }
        })
      );

      const signatureHash = createHash('sha256');
      for (const signaturePart of signatureParts) {
        signatureHash.update(signaturePart);
        signatureHash.update('\n');
      }

      return signatureHash.digest('hex');
    }

    private async collectTrackedDiscoveredEntries(): Promise<{
      discoveredSteps: string[];
      discoveredWorkflows: string[];
      discoveredSerdeFiles: string[];
    }> {
      if (this.trackedDependencyFiles.size === 0) {
        return {
          discoveredSteps: [],
          discoveredWorkflows: [],
          discoveredSerdeFiles: [],
        };
      }

      const { workflowFiles, stepFiles, serdeFiles } =
        await this.reconcileDiscoveredEntries({
          workflowCandidates: this.trackedDependencyFiles,
          stepCandidates: this.trackedDependencyFiles,
          serdeCandidates: this.trackedDependencyFiles,
          validatePatterns: true,
        });

      return {
        discoveredSteps: Array.from(stepFiles).sort(),
        discoveredWorkflows: Array.from(workflowFiles).sort(),
        discoveredSerdeFiles: Array.from(serdeFiles).sort(),
      };
    }

    private async refreshTrackedDependencyFiles(
      workflowGeneratedDir: string,
      routeFileName: string
    ): Promise<void> {
      const bundleFiles = [
        join(workflowGeneratedDir, `step/${routeFileName}`),
        join(workflowGeneratedDir, `flow/${routeFileName}`),
      ];
      const trackedFiles = new Set<string>();

      for (const bundleFile of bundleFiles) {
        const bundleSources = await this.extractBundleSourceFiles(bundleFile);
        for (const sourceFile of bundleSources) {
          trackedFiles.add(sourceFile);
        }
      }

      if (trackedFiles.size > 0) {
        this.trackedDependencyFiles = trackedFiles;
      }
    }

    private async extractBundleSourceFiles(
      bundleFilePath: string
    ): Promise<string[]> {
      let bundleContents: string;
      try {
        bundleContents = await readFile(bundleFilePath, 'utf-8');
      } catch {
        return [];
      }

      const baseDirectory = dirname(bundleFilePath);
      const localSourceFiles = new Set<string>();
      const sourceMapMatches = bundleContents.matchAll(
        /\/\/# sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)/g
      );

      for (const match of sourceMapMatches) {
        const base64Value = match[1];
        if (!base64Value) {
          continue;
        }

        let sourceMap: { sourceRoot?: unknown; sources?: unknown };
        try {
          sourceMap = JSON.parse(
            Buffer.from(base64Value, 'base64').toString('utf-8')
          ) as { sourceRoot?: unknown; sources?: unknown };
        } catch {
          continue;
        }

        const sourceRoot =
          typeof sourceMap.sourceRoot === 'string' ? sourceMap.sourceRoot : '';
        const sources = Array.isArray(sourceMap.sources)
          ? sourceMap.sources.filter(
              (source): source is string => typeof source === 'string'
            )
          : [];

        for (const source of sources) {
          if (source.startsWith('webpack://') || source.startsWith('<')) {
            continue;
          }

          let resolvedSourcePath: string;
          if (source.startsWith('file://')) {
            try {
              resolvedSourcePath = decodeURIComponent(new URL(source).pathname);
            } catch {
              continue;
            }
          } else if (isAbsolute(source)) {
            resolvedSourcePath = source;
          } else {
            resolvedSourcePath = resolve(baseDirectory, sourceRoot, source);
          }

          const normalizedSourcePath =
            this.normalizeDiscoveredFilePath(resolvedSourcePath);
          const normalizedSourcePathForCheck = normalizedSourcePath.replace(
            /\\/g,
            '/'
          );
          if (
            normalizedSourcePathForCheck.includes('/.well-known/workflow/') ||
            normalizedSourcePathForCheck.includes('/node_modules/') ||
            normalizedSourcePathForCheck.includes('/.pnpm/') ||
            normalizedSourcePathForCheck.includes('/.next/') ||
            normalizedSourcePathForCheck.endsWith('/virtual-entry.js')
          ) {
            continue;
          }

          localSourceFiles.add(normalizedSourcePath);
        }
      }

      return Array.from(localSourceFiles);
    }

    private scheduleWorkflowsCacheWrite(): void {
      if (this.cacheWriteTimer) {
        clearTimeout(this.cacheWriteTimer);
      }

      this.cacheWriteTimer = setTimeout(() => {
        this.cacheWriteTimer = null;
        void this.writeWorkflowsCache().catch((error) => {
          console.warn('Failed to write workflow discovery cache', error);
        });
      }, 50);
    }

    private async readWorkflowsCache(): Promise<{
      workflowFiles: string[];
      stepFiles: string[];
    } | null> {
      const cacheFilePath = this.getWorkflowsCacheFilePath();

      try {
        const cacheContents = await readFile(cacheFilePath, 'utf-8');
        const parsed = JSON.parse(cacheContents) as {
          workflowFiles?: unknown;
          stepFiles?: unknown;
        };

        const workflowFiles = Array.isArray(parsed.workflowFiles)
          ? parsed.workflowFiles.filter(
              (item): item is string => typeof item === 'string'
            )
          : [];
        const stepFiles = Array.isArray(parsed.stepFiles)
          ? parsed.stepFiles.filter(
              (item): item is string => typeof item === 'string'
            )
          : [];

        return { workflowFiles, stepFiles };
      } catch {
        return null;
      }
    }

    private async loadWorkflowsCache(): Promise<void> {
      const cachedData = await this.readWorkflowsCache();
      if (!cachedData) {
        return;
      }
      const { workflowFiles, stepFiles, serdeFiles } =
        await this.reconcileDiscoveredEntries({
          workflowCandidates: cachedData.workflowFiles,
          stepCandidates: cachedData.stepFiles,
          serdeCandidates: this.discoveredSerdeFiles,
          validatePatterns: true,
        });

      this.discoveredWorkflowFiles.clear();
      this.discoveredStepFiles.clear();
      this.discoveredSerdeFiles.clear();
      for (const filePath of workflowFiles) {
        this.discoveredWorkflowFiles.add(filePath);
      }
      for (const filePath of stepFiles) {
        this.discoveredStepFiles.add(filePath);
      }
      for (const filePath of serdeFiles) {
        this.discoveredSerdeFiles.add(filePath);
      }
    }

    private async writeWorkflowsCache(): Promise<void> {
      const cacheFilePath = this.getWorkflowsCacheFilePath();
      const cacheDir = join(this.config.workingDir, this.getDistDir(), 'cache');
      await mkdir(cacheDir, { recursive: true });

      const cacheData = {
        workflowFiles: Array.from(this.discoveredWorkflowFiles).sort(),
        stepFiles: Array.from(this.discoveredStepFiles).sort(),
      };

      await writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2));
    }

    private async writeStubFiles(outputDir: string): Promise<void> {
      // Turbopack currently has a worker-concurrency limitation for pending
      // virtual entries. Warn if parallelism is too low to reliably discover.
      const parallelismCount = os.availableParallelism();
      if (process.env.TURBOPACK && parallelismCount < 4) {
        console.warn(
          `Available parallelism of ${parallelismCount} is less than needed 4. This can cause workflows/steps to fail to discover properly in turbopack`
        );
      }

      const routeStubContent = [
        `// ${ROUTE_STUB_FILE_MARKER}`,
        'export const __workflowRouteStub = true;',
      ].join('\n');
      const workflowGeneratedDir = join(outputDir, '.well-known/workflow/v1');

      await mkdir(join(workflowGeneratedDir, 'flow'), { recursive: true });
      await mkdir(join(workflowGeneratedDir, 'step'), { recursive: true });
      await mkdir(join(workflowGeneratedDir, 'webhook/[token]'), {
        recursive: true,
      });

      await this.writeFileIfChanged(
        join(workflowGeneratedDir, '.gitignore'),
        '*'
      );

      // route.js stubs are replaced by generated route.js output once discovery
      // finishes and a deferred build completes.
      await this.writeFileIfChanged(
        join(workflowGeneratedDir, 'flow/route.js'),
        routeStubContent
      );
      await this.writeFileIfChanged(
        join(workflowGeneratedDir, 'step/route.js'),
        routeStubContent
      );
      await this.writeFileIfChanged(
        join(workflowGeneratedDir, 'webhook/[token]/route.js'),
        routeStubContent
      );
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
          experimentalTriggers: [STEP_QUEUE_TRIGGER],
        },
        workflows: {
          experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
        },
      };

      // We write this file to the generated directory for
      // the Next.js builder to consume
      await this.writeFileIfChanged(
        join(outputDir, '.well-known/workflow/v1/config.json'),
        JSON.stringify(generatedConfig, null, 2)
      );
    }

    private async writeFileIfChanged(
      filePath: string,
      contents: string | Buffer
    ): Promise<boolean> {
      const nextBuffer = Buffer.isBuffer(contents)
        ? contents
        : Buffer.from(contents);

      try {
        const currentBuffer = await readFile(filePath);
        if (currentBuffer.equals(nextBuffer)) {
          return false;
        }
      } catch {
        // File does not exist yet or cannot be read; write a fresh copy.
      }

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, nextBuffer);
      return true;
    }

    private async copyFileIfChanged(
      sourcePath: string,
      destinationPath: string
    ): Promise<boolean> {
      const sourceContents = await readFile(sourcePath);
      return this.writeFileIfChanged(destinationPath, sourceContents);
    }

    private sortJsonValue(value: unknown): unknown {
      if (Array.isArray(value)) {
        return value.map((item) => this.sortJsonValue(item));
      }
      if (value && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entryValue]) => [key, this.sortJsonValue(entryValue)]);
        return Object.fromEntries(sortedEntries);
      }
      return value;
    }

    private async rewriteJsonFileWithStableKeyOrder(
      filePath: string
    ): Promise<void> {
      try {
        const contents = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(contents) as unknown;
        const normalized = this.sortJsonValue(parsed);
        await this.writeFileIfChanged(
          filePath,
          `${JSON.stringify(normalized, null, 2)}\n`
        );
      } catch {
        // Manifest may not exist (e.g. manifest generation failed); ignore.
      }
    }

    private mergeWorkflowManifest(
      target: WorkflowManifest,
      source: WorkflowManifest
    ): void {
      if (source.steps) {
        target.steps = Object.assign(target.steps || {}, source.steps);
      }
      if (source.workflows) {
        target.workflows = Object.assign(
          target.workflows || {},
          source.workflows
        );
      }
      if (source.classes) {
        target.classes = Object.assign(target.classes || {}, source.classes);
      }
    }

    private async getRelativeFilenameForSwc(filePath: string): Promise<string> {
      const workingDir = this.config.workingDir;
      const normalizedWorkingDir = workingDir
        .replace(/\\/g, '/')
        .replace(/\/$/, '');
      const normalizedFilepath = filePath.replace(/\\/g, '/');

      // Windows fix: Use case-insensitive comparison to work around drive letter casing issues.
      const lowerWd = normalizedWorkingDir.toLowerCase();
      const lowerPath = normalizedFilepath.toLowerCase();

      let relativeFilename: string;
      if (lowerPath.startsWith(`${lowerWd}/`)) {
        relativeFilename = normalizedFilepath.substring(
          normalizedWorkingDir.length + 1
        );
      } else if (lowerPath === lowerWd) {
        relativeFilename = '.';
      } else {
        relativeFilename = relative(workingDir, filePath).replace(/\\/g, '/');
        if (relativeFilename.startsWith('../')) {
          const aliasedRelativePath = await resolveWorkflowAliasRelativePath(
            filePath,
            workingDir
          );
          if (aliasedRelativePath) {
            relativeFilename = aliasedRelativePath;
          } else {
            relativeFilename = relativeFilename
              .split('/')
              .filter((part) => part !== '..')
              .join('/');
          }
        }
      }

      if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
        relativeFilename = basename(normalizedFilepath);
      }

      return relativeFilename;
    }

    private getRelativeImportSpecifier(
      fromFilePath: string,
      toFilePath: string
    ): string {
      let relativePath = relative(dirname(fromFilePath), toFilePath).replace(
        /\\/g,
        '/'
      );
      if (!relativePath.startsWith('.')) {
        relativePath = `./${relativePath}`;
      }
      return relativePath;
    }

    private getStepCopyFileName(filePath: string): string {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const hash = createHash('sha256').update(normalizedPath).digest('hex');
      const extension = extname(normalizedPath);
      return `${hash.slice(0, 16)}${extension || '.js'}`;
    }

    private rewriteCopiedStepImportSpecifier(
      specifier: string,
      sourceFilePath: string,
      copiedFilePath: string,
      copiedStepFileBySourcePath: Map<string, string>
    ): string {
      if (!specifier.startsWith('.')) {
        return specifier;
      }

      const specifierMatch = specifier.match(/^([^?#]+)(.*)$/);
      const importPath = specifierMatch?.[1] ?? specifier;
      const suffix = specifierMatch?.[2] ?? '';
      const absoluteTargetPath = resolve(dirname(sourceFilePath), importPath);
      const resolvedTargetPath =
        this.resolveCopiedStepImportTargetPath(absoluteTargetPath);
      const normalizedTargetPath = resolvedTargetPath.replace(/\\/g, '/');
      const copiedTargetPath =
        copiedStepFileBySourcePath.get(normalizedTargetPath) ||
        (() => {
          try {
            const realTargetPath = realpathSync(resolvedTargetPath).replace(
              /\\/g,
              '/'
            );
            return copiedStepFileBySourcePath.get(realTargetPath);
          } catch {
            return undefined;
          }
        })();
      let rewrittenPath = relative(
        dirname(copiedFilePath),
        copiedTargetPath || resolvedTargetPath
      ).replace(/\\/g, '/');
      if (!rewrittenPath.startsWith('.')) {
        rewrittenPath = `./${rewrittenPath}`;
      }
      return `${rewrittenPath}${suffix}`;
    }

    private resolveCopiedStepImportTargetPath(targetPath: string): string {
      if (existsSync(targetPath)) {
        return targetPath;
      }

      const extensionMatch = targetPath.match(/(\.[^./\\]+)$/);
      const extension = extensionMatch?.[1]?.toLowerCase();
      if (!extension) {
        return targetPath;
      }

      const extensionFallbacks =
        extension === '.js'
          ? ['.ts', '.tsx', '.mts', '.cts']
          : extension === '.mjs'
            ? ['.mts']
            : extension === '.cjs'
              ? ['.cts']
              : extension === '.jsx'
                ? ['.tsx']
                : [];

      if (extensionFallbacks.length === 0) {
        return targetPath;
      }

      const targetWithoutExtension = targetPath.slice(0, -extension.length);
      for (const fallbackExtension of extensionFallbacks) {
        const fallbackPath = `${targetWithoutExtension}${fallbackExtension}`;
        if (existsSync(fallbackPath)) {
          return fallbackPath;
        }
      }

      return targetPath;
    }

    private rewriteRelativeImportsForCopiedStep(
      source: string,
      sourceFilePath: string,
      copiedFilePath: string,
      copiedStepFileBySourcePath: Map<string, string>
    ): string {
      const rewriteSpecifier = (specifier: string) =>
        this.rewriteCopiedStepImportSpecifier(
          specifier,
          sourceFilePath,
          copiedFilePath,
          copiedStepFileBySourcePath
        );
      const rewritePattern = (currentSource: string, pattern: RegExp): string =>
        currentSource.replace(
          pattern,
          (_match, prefix: string, specifier: string, suffix: string) =>
            `${prefix}${rewriteSpecifier(specifier)}${suffix}`
        );

      let rewrittenSource = source;
      rewrittenSource = rewritePattern(
        rewrittenSource,
        /(from\s+['"])([^'"]+)(['"])/g
      );
      rewrittenSource = rewritePattern(
        rewrittenSource,
        /(import\s+['"])([^'"]+)(['"])/g
      );
      rewrittenSource = rewritePattern(
        rewrittenSource,
        /(import\(\s*['"])([^'"]+)(['"]\s*\))/g
      );
      rewrittenSource = rewritePattern(
        rewrittenSource,
        /(require\(\s*['"])([^'"]+)(['"]\s*\))/g
      );
      return rewrittenSource;
    }

    private extractRelativeImportSpecifiers(source: string): string[] {
      const relativeSpecifiers = new Set<string>();
      const importPatterns = [
        /from\s+['"]([^'"]+)['"]/g,
        /import\s+['"]([^'"]+)['"]/g,
        /import\(\s*['"]([^'"]+)['"]\s*\)/g,
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];

      for (const importPattern of importPatterns) {
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1];
          if (specifier?.startsWith('.')) {
            relativeSpecifiers.add(specifier);
          }
        }
      }

      return Array.from(relativeSpecifiers);
    }

    private shouldSkipTransitiveStepFile(filePath: string): boolean {
      const normalizedPath = filePath.replace(/\\/g, '/');
      return (
        normalizedPath.includes('/.well-known/workflow/') ||
        normalizedPath.includes('/.next/') ||
        normalizedPath.includes('/node_modules/') ||
        normalizedPath.includes('/.pnpm/')
      );
    }

    private async resolveTransitiveStepImportTargetPath(
      sourceFilePath: string,
      specifier: string
    ): Promise<string | null> {
      const specifierMatch = specifier.match(/^([^?#]+)(.*)$/);
      const importPath = specifierMatch?.[1] ?? specifier;
      const absoluteTargetPath = resolve(dirname(sourceFilePath), importPath);

      const candidatePaths = new Set<string>([
        this.resolveCopiedStepImportTargetPath(absoluteTargetPath),
      ]);

      if (!extname(absoluteTargetPath)) {
        const extensionCandidates = [
          '.ts',
          '.tsx',
          '.mts',
          '.cts',
          '.js',
          '.jsx',
          '.mjs',
          '.cjs',
        ];
        for (const extensionCandidate of extensionCandidates) {
          candidatePaths.add(`${absoluteTargetPath}${extensionCandidate}`);
          candidatePaths.add(
            join(absoluteTargetPath, `index${extensionCandidate}`)
          );
        }
      }

      for (const candidatePath of candidatePaths) {
        const resolvedPath =
          this.resolveCopiedStepImportTargetPath(candidatePath);
        const normalizedResolvedPath =
          this.normalizeDiscoveredFilePath(resolvedPath);

        if (this.shouldSkipTransitiveStepFile(normalizedResolvedPath)) {
          continue;
        }

        try {
          const fileStats = await stat(normalizedResolvedPath);
          if (fileStats.isFile()) {
            return normalizedResolvedPath;
          }
        } catch {
          // Try the next candidate path.
        }
      }

      return null;
    }

    private async collectTransitiveStepFiles(
      stepFiles: string[]
    ): Promise<string[]> {
      const normalizedStepFiles = Array.from(
        new Set(
          stepFiles.map((stepFile) =>
            this.normalizeDiscoveredFilePath(stepFile)
          )
        )
      ).sort();
      const discoveredStepFiles = new Set(normalizedStepFiles);
      const queuedFiles = [...normalizedStepFiles];
      const visitedFiles = new Set<string>();
      const sourceCache = new Map<string, string | null>();
      const patternCache = new Map<
        string,
        ReturnType<typeof detectWorkflowPatterns> | null
      >();

      const getSource = async (filePath: string): Promise<string | null> => {
        if (sourceCache.has(filePath)) {
          return sourceCache.get(filePath) ?? null;
        }
        try {
          const source = await readFile(filePath, 'utf-8');
          sourceCache.set(filePath, source);
          return source;
        } catch {
          sourceCache.set(filePath, null);
          return null;
        }
      };

      const getPatterns = async (
        filePath: string
      ): Promise<ReturnType<typeof detectWorkflowPatterns> | null> => {
        if (patternCache.has(filePath)) {
          return patternCache.get(filePath) ?? null;
        }
        const source = await getSource(filePath);
        if (source === null) {
          patternCache.set(filePath, null);
          return null;
        }
        const patterns = detectWorkflowPatterns(source);
        patternCache.set(filePath, patterns);
        return patterns;
      };

      while (queuedFiles.length > 0) {
        const currentFile = queuedFiles.pop();
        if (!currentFile || visitedFiles.has(currentFile)) {
          continue;
        }
        visitedFiles.add(currentFile);

        const currentSource = await getSource(currentFile);
        if (currentSource === null) {
          continue;
        }

        const relativeImportSpecifiers =
          this.extractRelativeImportSpecifiers(currentSource);
        for (const specifier of relativeImportSpecifiers) {
          const resolvedImportPath =
            await this.resolveTransitiveStepImportTargetPath(
              currentFile,
              specifier
            );
          if (!resolvedImportPath) {
            continue;
          }

          if (!visitedFiles.has(resolvedImportPath)) {
            queuedFiles.push(resolvedImportPath);
          }

          const importPatterns = await getPatterns(resolvedImportPath);
          if (importPatterns?.hasUseStep) {
            discoveredStepFiles.add(resolvedImportPath);
          }
        }
      }

      return Array.from(discoveredStepFiles).sort();
    }

    private async collectTransitiveSerdeFiles({
      entryFiles,
      serdeFiles,
    }: {
      entryFiles: string[];
      serdeFiles: string[];
    }): Promise<string[]> {
      const normalizedEntryFiles = Array.from(
        new Set(
          entryFiles.map((entryFile) =>
            this.normalizeDiscoveredFilePath(entryFile)
          )
        )
      ).sort();
      const discoveredSerdeFiles = new Set(
        serdeFiles.map((serdeFile) =>
          this.normalizeDiscoveredFilePath(serdeFile)
        )
      );
      const queuedFiles = Array.from(
        new Set([...normalizedEntryFiles, ...discoveredSerdeFiles])
      );
      const visitedFiles = new Set<string>();
      const sourceCache = new Map<string, string | null>();
      const patternCache = new Map<
        string,
        ReturnType<typeof detectWorkflowPatterns> | null
      >();

      const getSource = async (filePath: string): Promise<string | null> => {
        if (sourceCache.has(filePath)) {
          return sourceCache.get(filePath) ?? null;
        }
        try {
          const source = await readFile(filePath, 'utf-8');
          sourceCache.set(filePath, source);
          return source;
        } catch {
          sourceCache.set(filePath, null);
          return null;
        }
      };

      const getPatterns = async (
        filePath: string
      ): Promise<ReturnType<typeof detectWorkflowPatterns> | null> => {
        if (patternCache.has(filePath)) {
          return patternCache.get(filePath) ?? null;
        }
        const source = await getSource(filePath);
        if (source === null) {
          patternCache.set(filePath, null);
          return null;
        }
        const patterns = detectWorkflowPatterns(source);
        patternCache.set(filePath, patterns);
        return patterns;
      };

      while (queuedFiles.length > 0) {
        const currentFile = queuedFiles.pop();
        if (!currentFile || visitedFiles.has(currentFile)) {
          continue;
        }
        visitedFiles.add(currentFile);

        const currentSource = await getSource(currentFile);
        if (currentSource === null) {
          continue;
        }

        const relativeImportSpecifiers =
          this.extractRelativeImportSpecifiers(currentSource);
        for (const specifier of relativeImportSpecifiers) {
          const resolvedImportPath =
            await this.resolveTransitiveStepImportTargetPath(
              currentFile,
              specifier
            );
          if (!resolvedImportPath) {
            continue;
          }

          if (!visitedFiles.has(resolvedImportPath)) {
            queuedFiles.push(resolvedImportPath);
          }

          const importPatterns = await getPatterns(resolvedImportPath);
          if (
            importPatterns?.hasSerde &&
            !isWorkflowSdkFile(resolvedImportPath)
          ) {
            discoveredSerdeFiles.add(resolvedImportPath);
          }
        }
      }

      return Array.from(discoveredSerdeFiles).sort();
    }

    private resolveBuiltInStepFilePath(): string | null {
      try {
        return this.normalizeDiscoveredFilePath(
          require.resolve('workflow/internal/builtins', {
            paths: [this.config.workingDir],
          })
        );
      } catch {
        return null;
      }
    }

    private async copyDiscoveredStepFiles({
      stepFiles,
      stepsRouteDir,
    }: {
      stepFiles: string[];
      stepsRouteDir: string;
    }): Promise<string[]> {
      const copiedStepsDir = join(stepsRouteDir, DEFERRED_STEP_COPY_DIR_NAME);
      await mkdir(copiedStepsDir, { recursive: true });

      const normalizedStepFiles = Array.from(
        new Set(
          stepFiles.map((stepFile) =>
            this.normalizeDiscoveredFilePath(stepFile)
          )
        )
      ).sort();
      const copiedStepFileBySourcePath = new Map<string, string>();
      const expectedFileNames = new Set<string>();
      const copiedStepFiles: string[] = [];

      for (const normalizedStepFile of normalizedStepFiles) {
        const copiedFileName = this.getStepCopyFileName(normalizedStepFile);
        const copiedFilePath = join(copiedStepsDir, copiedFileName);
        const normalizedPathKey = normalizedStepFile.replace(/\\/g, '/');
        copiedStepFileBySourcePath.set(normalizedPathKey, copiedFilePath);
        try {
          const realPathKey = realpathSync(normalizedStepFile).replace(
            /\\/g,
            '/'
          );
          copiedStepFileBySourcePath.set(realPathKey, copiedFilePath);
        } catch {
          // Keep best-effort mapping when source cannot be realpath-resolved.
        }
        expectedFileNames.add(copiedFileName);
        copiedStepFiles.push(copiedFilePath);
      }

      for (const normalizedStepFile of normalizedStepFiles) {
        const source = await readFile(normalizedStepFile, 'utf-8');
        const copiedFilePath = copiedStepFileBySourcePath.get(
          normalizedStepFile.replace(/\\/g, '/')
        );
        if (!copiedFilePath) {
          continue;
        }
        const rewrittenSource = this.rewriteRelativeImportsForCopiedStep(
          source,
          normalizedStepFile,
          copiedFilePath,
          copiedStepFileBySourcePath
        );
        const metadataComment = createDeferredStepSourceMetadataComment({
          relativeFilename:
            await this.getRelativeFilenameForSwc(normalizedStepFile),
          absolutePath: normalizedStepFile.replace(/\\/g, '/'),
        });
        const sourceMapComment = createDeferredStepCopyInlineSourceMapComment({
          sourcePath: normalizedStepFile,
          sourceContent: source,
          generatedContent: rewrittenSource,
        });
        const copiedSource = `${metadataComment}\n${rewrittenSource}\n${sourceMapComment}`;

        await this.writeFileIfChanged(copiedFilePath, copiedSource);
      }

      const existingEntries = await readdir(copiedStepsDir, {
        withFileTypes: true,
      }).catch(() => []);
      await Promise.all(
        existingEntries
          .filter((entry) => !expectedFileNames.has(entry.name))
          .map((entry) =>
            rm(join(copiedStepsDir, entry.name), {
              recursive: true,
              force: true,
            })
          )
      );

      return copiedStepFiles;
    }

    private async createDeferredStepsManifest({
      stepFiles,
      workflowFiles,
      serdeOnlyFiles,
    }: {
      stepFiles: string[];
      workflowFiles: string[];
      serdeOnlyFiles: string[];
    }): Promise<WorkflowManifest> {
      const workflowManifest: WorkflowManifest = {};
      const filesForStepTransform = Array.from(
        new Set([...stepFiles, ...serdeOnlyFiles])
      ).sort();

      await Promise.all(
        filesForStepTransform.map(async (stepFile) => {
          const source = await readFile(stepFile, 'utf-8');
          const relativeFilename =
            await this.getRelativeFilenameForSwc(stepFile);
          const { workflowManifest: fileManifest } = await applySwcTransform(
            relativeFilename,
            source,
            'step',
            stepFile
          );
          this.mergeWorkflowManifest(workflowManifest, fileManifest);
        })
      );

      const stepFileSet = new Set(stepFiles);
      const workflowOnlyFiles = workflowFiles
        .filter((workflowFile) => !stepFileSet.has(workflowFile))
        .sort();
      await Promise.all(
        workflowOnlyFiles.map(async (workflowFile) => {
          try {
            const source = await readFile(workflowFile, 'utf-8');
            const relativeFilename =
              await this.getRelativeFilenameForSwc(workflowFile);
            const { workflowManifest: fileManifest } = await applySwcTransform(
              relativeFilename,
              source,
              'workflow',
              workflowFile
            );
            this.mergeWorkflowManifest(workflowManifest, {
              workflows: fileManifest.workflows,
              classes: fileManifest.classes,
            });
          } catch (error) {
            console.log(
              `Warning: Failed to extract workflow metadata from ${workflowFile}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        })
      );

      return workflowManifest;
    }

    private async buildStepsFunction({
      workflowGeneratedDir,
      routeFileName = 'route.js',
      discoveredEntries,
    }: {
      workflowGeneratedDir: string;
      routeFileName?: string;
      discoveredEntries: DeferredDiscoveredEntries;
    }) {
      const stepsRouteDir = join(workflowGeneratedDir, 'step');
      await mkdir(stepsRouteDir, { recursive: true });
      const discovered = discoveredEntries;
      const stepFiles = await this.collectTransitiveStepFiles(
        [...discovered.discoveredSteps].sort()
      );
      const workflowFiles = [...discovered.discoveredWorkflows].sort();
      const serdeFiles = [...discovered.discoveredSerdeFiles].sort();
      const stepFileSet = new Set(stepFiles);
      const serdeOnlyFiles = serdeFiles.filter(
        (file) => !stepFileSet.has(file)
      );
      const builtInStepFilePath = this.resolveBuiltInStepFilePath();
      const copiedStepSourceFiles = builtInStepFilePath
        ? [
            builtInStepFilePath,
            ...stepFiles.filter((stepFile) => stepFile !== builtInStepFilePath),
          ]
        : stepFiles;
      const copiedStepFiles = await this.copyDiscoveredStepFiles({
        stepFiles: copiedStepSourceFiles,
        stepsRouteDir,
      });

      const stepRouteFile = join(stepsRouteDir, routeFileName);
      const copiedStepImports = copiedStepFiles
        .map((copiedStepFile) => {
          const importSpecifier = this.getRelativeImportSpecifier(
            stepRouteFile,
            copiedStepFile
          );
          return `import '${importSpecifier}';`;
        })
        .join('\n');
      const serdeImports = serdeOnlyFiles
        .map((serdeFile) => {
          const normalizedSerdeFile =
            this.normalizeDiscoveredFilePath(serdeFile);
          const { importPath, isPackage } = getImportPath(
            normalizedSerdeFile,
            this.config.workingDir
          );
          if (isPackage) {
            return `import '${importPath}';`;
          }
          const importSpecifier = this.getRelativeImportSpecifier(
            stepRouteFile,
            normalizedSerdeFile
          );
          return `import '${importSpecifier}';`;
        })
        .join('\n');

      const routeContents = [
        '// biome-ignore-all lint: generated file',
        '/* eslint-disable */',
        builtInStepFilePath ? '' : "import 'workflow/internal/builtins';",
        copiedStepImports,
        serdeImports
          ? `// Serde files for cross-context class registration\n${serdeImports}`
          : '',
        "export { stepEntrypoint as POST } from 'workflow/runtime';",
      ]
        .filter(Boolean)
        .join('\n');

      await this.writeFileIfChanged(stepRouteFile, routeContents);

      const manifest = await this.createDeferredStepsManifest({
        stepFiles: copiedStepSourceFiles,
        workflowFiles,
        serdeOnlyFiles,
      });

      return {
        context: undefined,
        manifest,
      };
    }

    private async buildWorkflowsFunction({
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath,
      routeFileName = 'route.js',
      discoveredEntries,
    }: {
      inputFiles: string[];
      workflowGeneratedDir: string;
      tsconfigPath?: string;
      routeFileName?: string;
      discoveredEntries: DeferredDiscoveredEntries;
    }) {
      const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
      await mkdir(workflowsRouteDir, { recursive: true });
      return await this.createWorkflowsBundle({
        format: 'esm',
        outfile: join(workflowsRouteDir, routeFileName),
        bundleFinalOutput: false,
        inputFiles,
        tsconfigPath,
        discoveredEntries,
      });
    }

    private async buildWebhookRoute({
      workflowGeneratedDir,
      routeFileName = 'route.js',
    }: {
      workflowGeneratedDir: string;
      routeFileName?: string;
    }): Promise<void> {
      const webhookRouteFile = join(
        workflowGeneratedDir,
        `webhook/[token]/${routeFileName}`
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

  CachedNextBuilderDeferred = NextDeferredBuilder;
  return NextDeferredBuilder;
}
