import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  createSocketServer,
  type SocketIO,
  type SocketServerConfig,
} from './socket-server.js';

const ROUTE_STUB_FILE_MARKER = 'WORKFLOW_ROUTE_STUB_FILE';

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
    detectWorkflowPatterns,
    isWorkflowSdkFile,
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

      await this.writeStubFiles(outputDir);
      await this.createDiscoverySocketServer();
    }

    async onBeforeDeferredEntries(): Promise<void> {
      await this.initializeDiscoveryState();
      await this.validateDiscoveredEntryFiles();
      const implicitStepFiles = await this.resolveImplicitStepFiles();

      const inputFiles = Array.from(
        new Set([
          ...this.discoveredWorkflowFiles,
          ...this.discoveredStepFiles,
          ...implicitStepFiles,
        ])
      ).sort();
      const pendingBuild = this.deferredBuildQueue.then(() =>
        this.buildDeferredEntriesUntilStable(inputFiles, implicitStepFiles)
      );

      // Keep the queue chain alive even when the current build fails so future
      // callbacks can enqueue another attempt without triggering unhandled
      // rejection warnings.
      this.deferredBuildQueue = pendingBuild.catch(() => {
        // Error is surfaced through `pendingBuild` below.
      });

      await pendingBuild;
    }

    private async buildDeferredEntriesUntilStable(
      inputFiles: string[],
      implicitStepFiles: string[]
    ): Promise<void> {
      // A successful build can discover additional transitive dependency files
      // (via source maps), which changes the signature and may require one more
      // build pass to include newly discovered serde files.
      const maxBuildPasses = 3;

      for (let buildPass = 0; buildPass < maxBuildPasses; buildPass++) {
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

        const postBuildSignature =
          await this.createDeferredBuildSignature(inputFiles);
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
      const discoveredStepFiles = Array.from(
        new Set([...this.discoveredStepFiles, ...implicitStepFiles])
      ).sort();
      const discoveredWorkflowFiles = Array.from(
        this.discoveredWorkflowFiles
      ).sort();
      const trackedSerdeFiles = await this.collectTrackedSerdeFiles();
      const discoveredSerdeFiles = Array.from(
        new Set([...this.discoveredSerdeFiles, ...trackedSerdeFiles])
      ).sort();
      const discoveredEntries = {
        discoveredSteps: discoveredStepFiles,
        discoveredWorkflows: discoveredWorkflowFiles,
        discoveredSerdeFiles,
      };

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });

      await this.writeFileIfChanged(
        join(workflowGeneratedDir, '.gitignore'),
        '*'
      );

      const tsconfigPath = await this.findTsConfigPath();

      const options = {
        inputFiles,
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
      await this.rewriteJsonFileWithStableKeyOrder(manifestBuildPath);
      await this.copyFileIfChanged(manifestBuildPath, manifestFilePath);

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

    private async collectTrackedSerdeFiles(): Promise<string[]> {
      if (this.trackedDependencyFiles.size === 0) {
        return [];
      }

      const { serdeFiles } = await this.reconcileDiscoveredEntries({
        workflowCandidates: [],
        stepCandidates: [],
        serdeCandidates: this.trackedDependencyFiles,
        validatePatterns: true,
      });

      return Array.from(serdeFiles);
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

    private async buildStepsFunction({
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
      discoveredEntries?: {
        discoveredSteps: string[];
        discoveredWorkflows: string[];
        discoveredSerdeFiles: string[];
      };
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
        outfile: join(stepsRouteDir, routeFileName),
        externalizeNonSteps: true,
        tsconfigPath,
        discoveredEntries,
      });
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
      discoveredEntries?: {
        discoveredSteps: string[];
        discoveredWorkflows: string[];
        discoveredSerdeFiles: string[];
      };
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
