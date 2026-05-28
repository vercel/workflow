import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
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
  cleanupStaleSocketInfoFiles,
  createSocketServer,
  SOCKET_INFO_FILENAME,
  type SocketIO,
  type SocketServerConfig,
} from './socket-server.js';

const ROUTE_STUB_FILE_MARKER = 'WORKFLOW_ROUTE_STUB_FILE';
const ROUTE_STUB_MARKER_SCAN_BYTES = 4 * 1024;

let CachedNextBuilderDeferred: any;

// Create the deferred Next builder dynamically by extending the ESM BaseBuilder.
// Exported as getNextBuilderDeferred() to allow CommonJS modules to import from
// the ESM @workflow/builders package via dynamic import at runtime.
export async function getNextBuilderDeferred() {
  if (CachedNextBuilderDeferred) {
    return CachedNextBuilderDeferred;
  }

  // V2: STEP_QUEUE_TRIGGER, getImportPath, and enhanced-resolve infrastructure
  // were removed because the V2 combined handler eliminates the separate step
  // route/topic. The step copy import rewriting (getRelativeImportSpecifier,
  // getStepCopyFileName, rewriteRelativeImportsForCopiedStep) from main was also
  // removed — V2 doesn't use step copies. If step copy support is needed, it
  // should land as a complete feature set.
  const {
    BaseBuilder: BaseBuilderClass,
    WORKFLOW_QUEUE_TRIGGER,
    detectWorkflowPatterns,
    applySwcTransform,
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
    private deferredRebuildTimer: NodeJS.Timeout | null = null;
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
        const shouldForceBuildForGeneratedRoutes =
          await this.shouldForceBuildForGeneratedRoutes();
        if (
          buildSignature === this.lastDeferredBuildSignature &&
          !shouldForceBuildForGeneratedRoutes
        ) {
          return;
        }

        try {
          await this.buildDiscoveredFiles(inputFiles, implicitStepFiles);
        } catch (error) {
          if (this.config.watch) {
            await this.validateDiscoveredEntryFiles();
            const recoveredInputFiles =
              this.getCurrentInputFiles(implicitStepFiles);
            const recoveredSignature =
              await this.createDeferredBuildSignature(recoveredInputFiles);
            if (recoveredSignature !== buildSignature) {
              // A file was added/removed while this build was running; retry
              // immediately with the refreshed discovered-entry state.
              continue;
            }
            console.warn(
              '[workflow] Deferred entries build failed. Will retry only after inputs change.',
              error
            );
            this.lastDeferredBuildSignature = buildSignature;
            return;
          } else {
            throw error;
          }
        }
        this.lastDeferredBuildSignature = buildSignature;

        if (!this.config.watch) {
          // Production builds can persist newly discovered deferred-entry files to
          // the cache after the first pass completes. Reload that cache before we
          // decide whether the input signature stabilized so staged tarball builds
          // can immediately replay with the expanded step set.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await this.loadWorkflowsCache();
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
      const workflowStdlibPath = this.resolveWorkflowStdlibStepFilePath();
      return workflowStdlibPath ? [workflowStdlibPath] : [];
    }

    private async shouldForceBuildForGeneratedRoutes(): Promise<boolean> {
      const outputDir = await this.findAppDirectory();
      const generatedRouteFiles = [
        join(outputDir, '.well-known/workflow/v1/flow/route.js'),
        join(outputDir, '.well-known/workflow/v1/webhook/[token]/route.js'),
      ];

      for (const routeFilePath of generatedRouteFiles) {
        const routeState = await this.getGeneratedRouteState(routeFilePath);
        if (routeState === 'missing' || routeState === 'stub') {
          return true;
        }
      }

      return false;
    }

    private async getGeneratedRouteState(
      routeFilePath: string
    ): Promise<'missing' | 'stub' | 'generated'> {
      let routeStats;
      try {
        routeStats = await stat(routeFilePath);
      } catch {
        return 'missing';
      }
      if (!routeStats.isFile()) {
        return 'missing';
      }

      try {
        const routeFileHandle = await open(routeFilePath, 'r');
        try {
          const markerScanBuffer = Buffer.alloc(ROUTE_STUB_MARKER_SCAN_BYTES);
          const { bytesRead } = await routeFileHandle.read(
            markerScanBuffer,
            0,
            ROUTE_STUB_MARKER_SCAN_BYTES,
            0
          );
          const markerScanSource = markerScanBuffer.toString(
            'utf8',
            0,
            bytesRead
          );
          return markerScanSource.includes(ROUTE_STUB_FILE_MARKER)
            ? 'stub'
            : 'generated';
        } finally {
          await routeFileHandle.close();
        }
      } catch {
        return 'missing';
      }
    }

    private resolveWorkflowStdlibStepFilePath(): string | null {
      let workflowCjsEntry: string;
      try {
        workflowCjsEntry = require.resolve('workflow', {
          paths: [this.config.workingDir],
        });
      } catch {
        return null;
      }

      const workflowDistDir = dirname(workflowCjsEntry);
      const workflowStdlibPath = this.normalizeDiscoveredFilePath(
        join(workflowDistDir, 'stdlib.js')
      );
      return existsSync(workflowStdlibPath) ? workflowStdlibPath : null;
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
              return {
                filePath,
                hasUseWorkflow: candidates.hasWorkflowCandidate,
                hasUseStep: candidates.hasStepCandidate,
                hasSerde: candidates.hasSerdeCandidate,
              };
            }

            const source = await readFile(filePath, 'utf-8');
            const patterns = detectWorkflowPatterns(source);
            return {
              filePath,
              hasUseWorkflow: patterns.hasUseWorkflow,
              hasUseStep: patterns.hasUseStep,
              hasSerde: patterns.hasSerde,
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
      const workflowCandidates = new Set(this.discoveredWorkflowFiles);
      const stepCandidates = new Set(this.discoveredStepFiles);
      const serdeCandidates = new Set(this.discoveredSerdeFiles);
      const { workflowFiles, stepFiles, serdeFiles } =
        await this.reconcileDiscoveredEntries({
          workflowCandidates,
          stepCandidates,
          serdeCandidates,
          validatePatterns: true,
        });

      // Reconcile validated entries against the snapshot we started with so
      // file discoveries that arrive during validation are preserved.
      let workflowsChanged = false;
      let stepsChanged = false;
      let serdeChanged = false;

      for (const filePath of workflowCandidates) {
        if (!workflowFiles.has(filePath)) {
          workflowsChanged =
            this.discoveredWorkflowFiles.delete(filePath) || workflowsChanged;
        }
      }
      for (const filePath of workflowFiles) {
        if (!this.discoveredWorkflowFiles.has(filePath)) {
          this.discoveredWorkflowFiles.add(filePath);
          workflowsChanged = true;
        }
      }

      for (const filePath of stepCandidates) {
        if (!stepFiles.has(filePath)) {
          stepsChanged =
            this.discoveredStepFiles.delete(filePath) || stepsChanged;
        }
      }
      for (const filePath of stepFiles) {
        if (!this.discoveredStepFiles.has(filePath)) {
          this.discoveredStepFiles.add(filePath);
          stepsChanged = true;
        }
      }

      for (const filePath of serdeCandidates) {
        if (!serdeFiles.has(filePath)) {
          serdeChanged =
            this.discoveredSerdeFiles.delete(filePath) || serdeChanged;
        }
      }
      for (const filePath of serdeFiles) {
        if (!this.discoveredSerdeFiles.has(filePath)) {
          this.discoveredSerdeFiles.add(filePath);
          serdeChanged = true;
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
      const discoveredStepFileCandidates = Array.from(
        new Set([
          ...this.discoveredStepFiles,
          ...trackedDiscoveredEntries.discoveredSteps,
          ...implicitStepFiles,
        ])
      ).sort();
      const discoveredWorkflowFileCandidates = Array.from(
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
      const discoveredWorkflowFiles = await this.filterExistingFiles(
        discoveredWorkflowFileCandidates
      );
      const existingStepFileCandidates = await this.filterExistingFiles(
        discoveredStepFileCandidates
      );
      const discoveredStepFiles = await this.collectTransitiveStepFiles({
        entryFiles: [...existingStepFileCandidates, ...discoveredWorkflowFiles],
        stepFiles: existingStepFileCandidates,
      });
      const existingSerdeFileCandidates = await this.filterExistingFiles(
        discoveredSerdeFileCandidates
      );
      const discoveredSerdeFiles = await this.collectTransitiveSerdeFiles({
        entryFiles: [...discoveredStepFiles, ...discoveredWorkflowFiles],
        serdeFiles: existingSerdeFileCandidates,
      });
      const existingInputFiles = await this.filterExistingFiles(inputFiles);
      const buildInputFiles = Array.from(
        new Set([
          ...existingInputFiles,
          ...discoveredStepFiles,
          ...discoveredWorkflowFiles,
          ...discoveredSerdeFiles,
        ])
      ).sort();
      const discoveredEntries = {
        discoveredSteps: new Set(discoveredStepFiles),
        discoveredWorkflows: new Set(discoveredWorkflowFiles),
        discoveredSerdeFiles: new Set(discoveredSerdeFiles),
      };

      // Ensure output directories exist
      await mkdir(workflowGeneratedDir, { recursive: true });

      await this.writeFileIfChanged(
        join(workflowGeneratedDir, '.gitignore'),
        '*'
      );

      const tsconfigPath = await this.findTsConfigPath();

      // V2: Build combined route (replaces separate step + flow routes)
      const flowRouteDir = join(workflowGeneratedDir, 'flow');
      await mkdir(flowRouteDir, { recursive: true });
      // Write step registrations to final name directly (not temp) so the
      // import path in the flow route is correct. The flow route uses temp
      // naming to avoid HMR churn via copyFileIfChanged, but the step
      // registrations file is a side-effect import and doesn't need that.
      const stepsOutfile = join(flowRouteDir, '__step_registrations.js');
      const combinedResult = await this.createCombinedBundle({
        format: 'esm',
        inputFiles: buildInputFiles,
        stepsOutfile,
        flowOutfile: join(flowRouteDir, tempRouteFileName),
        bundleFinalOutput: false,
        externalizeNonSteps: true,
        tsconfigPath,
        discoveredEntries,
      });
      await this.buildWebhookRoute({
        workflowGeneratedDir,
        routeFileName: tempRouteFileName,
      });
      await this.refreshTrackedDependencyFiles(
        workflowGeneratedDir,
        tempRouteFileName
      );

      const manifest = {
        steps: { ...combinedResult?.manifest?.steps },
        workflows: { ...combinedResult?.manifest?.workflows },
        classes: { ...combinedResult?.manifest?.classes },
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

      // V2: Combined route (flow) — step registrations already at final path
      await this.copyFileIfChanged(
        join(workflowGeneratedDir, `flow/${tempRouteFileName}`),
        join(workflowGeneratedDir, 'flow/route.js')
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
        if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
          await this.writeFileIfChanged(
            join(publicManifestDir, '.gitignore'),
            '*'
          );
        }
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
        join(flowRouteDir, '__step_registrations.route.js.temp'),
        join(flowRouteDir, '__step_registrations.route.js.temp.debug.json'),
        // V2: clean up stale V1 step route directory
        stepRouteDir,
        join(webhookRouteDir, 'route.js.temp'),
        join(workflowGeneratedDir, 'manifest.json'),
      ];

      await Promise.all([
        ...staleArtifactPaths.map((stalePath) =>
          rm(stalePath, { recursive: true, force: true })
        ),
        cleanupStaleSocketInfoFiles(
          join(this.config.workingDir, this.getDistDir())
        ),
        this.removeStaleDeferredTempFiles(flowRouteDir),
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

      process.env.WORKFLOW_SOCKET_INFO_PATH = this.getSocketInfoFilePath();
      const config: SocketServerConfig = {
        isDevServer: Boolean(this.config.watch),
        socketInfoFilePath: this.getSocketInfoFilePath(),
        onFileDiscovered: (
          filePath: string,
          hasWorkflow: boolean,
          hasStep: boolean,
          hasSerde: boolean
        ) => {
          const normalizedFilePath = this.normalizeDiscoveredFilePath(filePath);
          let hasCacheTrackingChange = false;
          const wasTrackedDependency =
            this.trackedDependencyFiles.has(normalizedFilePath);

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
            if (!this.discoveredSerdeFiles.has(normalizedFilePath)) {
              hasCacheTrackingChange = true;
            }
            this.discoveredSerdeFiles.add(normalizedFilePath);
          } else {
            const wasDeleted =
              this.discoveredSerdeFiles.delete(normalizedFilePath);
            hasCacheTrackingChange = wasDeleted || hasCacheTrackingChange;
          }

          if (hasCacheTrackingChange) {
            this.scheduleWorkflowsCacheWrite();
          }

          if (
            hasWorkflow ||
            hasStep ||
            hasSerde ||
            hasCacheTrackingChange ||
            wasTrackedDependency
          ) {
            this.scheduleDeferredRebuild();
          }
        },
        onTriggerBuild: () => {
          this.scheduleDeferredRebuild();
        },
      };

      this.socketIO = await createSocketServer(config);
    }

    private async initializeDiscoveryState(): Promise<void> {
      if (this.cacheInitialized) {
        return;
      }

      await this.loadWorkflowsCache();
      // Deferred mode must not run eager input-graph discovery; entries are
      // discovered via loader->socket notifications during Next's build.
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

    private getSocketInfoFilePath(): string {
      return join(
        this.config.workingDir,
        this.getDistDir(),
        SOCKET_INFO_FILENAME
      );
    }

    private findPackageJsonPath(filePath: string): string | null {
      let currentDir = dirname(filePath);
      let previousDir = '';

      while (currentDir !== previousDir) {
        const packageJsonPath = join(currentDir, 'package.json');
        if (existsSync(packageJsonPath)) {
          return packageJsonPath;
        }
        previousDir = currentDir;
        currentDir = dirname(currentDir);
      }

      return null;
    }

    private shouldPreferSourceBackedPackagePath(filePath: string): boolean {
      const normalizedPath = filePath.replace(/\\/g, '/');
      // Only prefer source for workspace packages (not in node_modules).
      // For tarball-installed packages, using source-backed paths causes
      // esbuild to bundle the full source tree (including world.ts with
      // process.cwd()) instead of externalizing properly.
      if (
        normalizedPath.includes('/packages/') &&
        !normalizedPath.includes('/node_modules/')
      ) {
        return true;
      }

      if (!normalizedPath.includes('/node_modules/')) {
        return false;
      }

      const packageJsonPath = this.findPackageJsonPath(filePath);
      if (!packageJsonPath) {
        return false;
      }

      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, 'utf-8')
        ) as { name?: unknown };
        return (
          packageJson.name === 'workflow' ||
          (typeof packageJson.name === 'string' &&
            packageJson.name.startsWith('@workflow/'))
        );
      } catch {
        return false;
      }
    }

    private resolveSourceBackedPackagePath(filePath: string): string {
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (!normalizedPath.includes('/dist/')) {
        return filePath;
      }

      const sourceCandidate = normalizedPath.replace('/dist/', '/src/');
      const resolvedSourceCandidate =
        this.resolveCopiedStepImportTargetPath(sourceCandidate);
      if (
        !existsSync(resolvedSourceCandidate) ||
        !this.shouldPreferSourceBackedPackagePath(filePath)
      ) {
        return filePath;
      }

      return existsSync(resolvedSourceCandidate)
        ? resolvedSourceCandidate
        : filePath;
    }

    private normalizeDiscoveredFilePath(filePath: string): string {
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(this.config.workingDir, filePath);
      return this.resolveSourceBackedPackagePath(absolutePath);
    }

    private async filterExistingFiles(filePaths: string[]): Promise<string[]> {
      const normalizedFilePaths = Array.from(
        new Set(
          filePaths.map((filePath) =>
            this.normalizeDiscoveredFilePath(filePath)
          )
        )
      ).sort();

      const existingFiles = await Promise.all(
        normalizedFilePaths.map(async (filePath) => {
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

      // Extract inline base64 sourcemaps via string scanning. A previous
      // implementation used `bundleContents.matchAll(/...[A-Za-z0-9+/=]+.../g)`
      // which overflows V8's regex stack
      // (`RangeError: Maximum call stack size exceeded at RegExpStringIterator.next`)
      // on bundles with large inline sourcemaps — V8's irregexp uses
      // recursion for greedy character-class quantifiers and certain long
      // base64 inputs exhaust the call stack.
      const sourceMapPrefix = '//# sourceMappingURL=data:application/json';
      const base64Marker = ';base64,';
      const sourceMapMatches: Array<{ base64Value: string }> = [];
      let scanFrom = 0;
      while (scanFrom < bundleContents.length) {
        const prefixIdx = bundleContents.indexOf(sourceMapPrefix, scanFrom);
        if (prefixIdx === -1) break;
        const base64Start = bundleContents.indexOf(
          base64Marker,
          prefixIdx + sourceMapPrefix.length
        );
        if (base64Start === -1) {
          scanFrom = prefixIdx + sourceMapPrefix.length;
          continue;
        }
        // Bail if a comma appears before `;base64,` — that means this
        // wasn't a `data:application/json[;params];base64,...` URL after
        // all (the comma would terminate the data URL parameters).
        const commaBefore = bundleContents.indexOf(',', prefixIdx);
        if (commaBefore !== -1 && commaBefore < base64Start) {
          scanFrom = base64Start;
          continue;
        }
        const valueStart = base64Start + base64Marker.length;
        // Base64 payload terminates at first non-base64 char (newline,
        // closing `*/`, etc.). Scanning a small alphabet by char is far
        // cheaper than backtracking a regex over a multi-MB capture.
        let valueEnd = valueStart;
        while (valueEnd < bundleContents.length) {
          const code = bundleContents.charCodeAt(valueEnd);
          // A-Z 0x41-0x5A, a-z 0x61-0x7A, 0-9 0x30-0x39, '+' 0x2B,
          // '/' 0x2F, '=' 0x3D
          if (
            !(
              (code >= 0x41 && code <= 0x5a) ||
              (code >= 0x61 && code <= 0x7a) ||
              (code >= 0x30 && code <= 0x39) ||
              code === 0x2b ||
              code === 0x2f ||
              code === 0x3d
            )
          ) {
            break;
          }
          valueEnd++;
        }
        if (valueEnd > valueStart) {
          sourceMapMatches.push({
            base64Value: bundleContents.slice(valueStart, valueEnd),
          });
        }
        scanFrom = valueEnd;
      }

      for (const match of sourceMapMatches) {
        const base64Value = match.base64Value;
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
          const isSourceBackedPackagePath =
            this.shouldPreferSourceBackedPackagePath(normalizedSourcePath);
          if (
            normalizedSourcePathForCheck.includes('/.well-known/workflow/') ||
            (!isSourceBackedPackagePath &&
              normalizedSourcePathForCheck.includes('/node_modules/')) ||
            (!isSourceBackedPackagePath &&
              normalizedSourcePathForCheck.includes('/.pnpm/')) ||
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

    private scheduleDeferredRebuild(): void {
      if (this.deferredRebuildTimer) {
        clearTimeout(this.deferredRebuildTimer);
      }

      this.deferredRebuildTimer = setTimeout(() => {
        this.deferredRebuildTimer = null;
        void this.onBeforeDeferredEntries().catch((error) => {
          console.warn(
            '[workflow] Deferred rebuild after source update failed.',
            error
          );
        });
      }, 75);
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
      await mkdir(join(workflowGeneratedDir, 'webhook/[token]'), {
        recursive: true,
      });

      await this.writeFileIfChanged(
        join(workflowGeneratedDir, '.gitignore'),
        '*'
      );

      // V2: Only flow + webhook stubs needed (no separate step route).
      // Stubs are replaced by generated output once discovery finishes.
      await this.writeFileIfChanged(
        join(workflowGeneratedDir, 'flow/route.js'),
        routeStubContent
      );
      await this.writeFileIfChanged(
        join(workflowGeneratedDir, 'webhook/[token]/route.js'),
        routeStubContent
      );
    }

    protected async getInputFiles(): Promise<string[]> {
      // Read Next.js's app-paths-manifest.json from a previous build to
      // determine which files are actual route entrypoints. This avoids
      // predicting Next.js conventions with regexes and instead reads
      // from Next.js's own output.
      const nextDir = join(this.config.workingDir, '.next');
      const manifestPath = join(nextDir, 'app-paths-manifest.json');
      try {
        const manifestContent = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as Record<string, string>;
        // The manifest maps route paths to their source files.
        // Extract the source file paths and resolve them.
        const manifestFiles = new Set<string>();
        for (const sourcePath of Object.values(manifest)) {
          const resolved = resolve(nextDir, 'server', sourcePath);
          // The manifest points to built output; find the source file
          // by matching against the base builder's full file list.
          manifestFiles.add(resolved);
        }

        // Use the manifest route paths to filter the input files.
        // A file is included if it matches a known route segment from
        // the manifest (e.g., app/api/route contains 'app/api/route').
        const inputFiles = await super.getInputFiles();
        const routeSegments = Object.keys(manifest).map((route) =>
          route.replace(/^\//, '').replace(/\/route$/, '')
        );
        return inputFiles.filter((item) =>
          routeSegments.some((segment) => item.includes(segment))
        );
      } catch {
        // No manifest from a previous build — fall back to the base
        // builder's full file scan. This is safe but slower; subsequent
        // builds will use the manifest.
        return super.getInputFiles();
      }
    }

    private async writeFunctionsConfig(outputDir: string) {
      // we don't run this in development mode as it's not needed
      if (process.env.NODE_ENV === 'development') {
        return;
      }
      // V2: Single combined trigger handles both workflow and step execution
      const generatedConfig = {
        version: '0',
        workflows: {
          maxDuration: 'max',
          experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
        },
      };

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

    private extractRelativeImportSpecifiers(source: string): string[] {
      return this.extractImportSpecifiers(source).filter((specifier) =>
        specifier.startsWith('.')
      );
    }

    private extractImportSpecifiers(source: string): string[] {
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
          if (specifier) {
            relativeSpecifiers.add(specifier);
          }
        }
      }

      return Array.from(relativeSpecifiers);
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

    private resolveImportTargetWithExtensionFallbacks(
      targetPath: string
    ): string {
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

    private shouldSkipTransitiveStepFile(filePath: string): boolean {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const isSourceBackedPackagePath =
        this.shouldPreferSourceBackedPackagePath(filePath);
      return (
        normalizedPath.includes('/.well-known/workflow/') ||
        normalizedPath.includes('/.next/') ||
        (!isSourceBackedPackagePath &&
          (normalizedPath.includes('/node_modules/') ||
            normalizedPath.includes('/.pnpm/')))
      );
    }

    private async resolveTransitiveStepImportTargetPath(
      sourceFilePath: string,
      specifier: string
    ): Promise<string | null> {
      const specifierMatch = specifier.match(/^([^?#]+)(.*)$/);
      const importPath = specifierMatch?.[1] ?? specifier;

      if (!importPath.startsWith('.')) {
        if (importPath !== 'workflow' && !importPath.startsWith('@workflow/')) {
          return null;
        }

        try {
          const resolvedPath =
            createRequire(sourceFilePath).resolve(importPath);
          const normalizedResolvedPath =
            this.normalizeDiscoveredFilePath(resolvedPath);
          if (this.shouldSkipTransitiveStepFile(normalizedResolvedPath)) {
            return null;
          }

          const fileStats = await stat(normalizedResolvedPath);
          return fileStats.isFile() ? normalizedResolvedPath : null;
        } catch {
          return null;
        }
      }

      const absoluteTargetPath = resolve(dirname(sourceFilePath), importPath);

      const candidatePaths = new Set<string>([
        this.resolveImportTargetWithExtensionFallbacks(absoluteTargetPath),
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
          this.resolveImportTargetWithExtensionFallbacks(candidatePath);
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

    private async collectTransitiveStepFiles({
      entryFiles,
      stepFiles,
    }: {
      entryFiles: string[];
      stepFiles: string[];
    }): Promise<string[]> {
      const normalizedEntryFiles = Array.from(
        new Set(
          entryFiles.map((entryFile) =>
            this.normalizeDiscoveredFilePath(entryFile)
          )
        )
      ).sort();
      const normalizedStepSeedFiles = Array.from(
        new Set(
          stepFiles.map((stepFile) =>
            this.normalizeDiscoveredFilePath(stepFile)
          )
        )
      ).sort();
      const discoveredStepFiles = new Set<string>(normalizedStepSeedFiles);
      const queuedFiles = Array.from(
        new Set([...normalizedEntryFiles, ...normalizedStepSeedFiles])
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

        const importSpecifiers = this.extractImportSpecifiers(currentSource);
        for (const specifier of importSpecifiers) {
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
      const normalizedSerdeSeedFiles = Array.from(
        new Set(
          serdeFiles.map((serdeFile) =>
            this.normalizeDiscoveredFilePath(serdeFile)
          )
        )
      ).sort();
      // Intentionally re-validate serde seeds against source patterns.
      // This keeps previously discovered/manual seed entries from sticking when
      // files no longer match serde patterns.
      const discoveredSerdeFiles = new Set<string>();
      const queuedFiles = Array.from(
        new Set([...normalizedEntryFiles, ...normalizedSerdeSeedFiles])
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

      for (const serdeSeedFile of normalizedSerdeSeedFiles) {
        const seedPatterns = await getPatterns(serdeSeedFile);
        if (seedPatterns?.hasSerde) {
          discoveredSerdeFiles.add(serdeSeedFile);
        }
      }

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
          if (importPatterns?.hasSerde) {
            discoveredSerdeFiles.add(resolvedImportPath);
          }
        }
      }

      // AST-level verification: run SWC detect mode on regex-matched candidates
      // to confirm they actually define serde classes. This prevents SDK internal
      // files (which match serde regex patterns but define no classes) from being
      // bundled into the workflow sandbox.
      const projectRoot = this.config.projectRoot || this.config.workingDir;
      const verifiedSerdeFiles: string[] = [];
      await Promise.all(
        Array.from(discoveredSerdeFiles).map(async (filePath) => {
          const source = await getSource(filePath);
          if (!source) return;
          try {
            const relativeFilename =
              await this.getRelativeFilenameForSwc(filePath);
            const { workflowManifest } = await applySwcTransform(
              relativeFilename,
              source,
              'detect',
              filePath,
              projectRoot
            );
            // Only include files that actually define serde classes
            const hasClasses =
              workflowManifest.classes &&
              Object.values(workflowManifest.classes).some(
                (entries) => Object.keys(entries).length > 0
              );
            if (hasClasses) {
              verifiedSerdeFiles.push(filePath);
            }
          } catch {
            // If detect fails, include the file to be safe
            verifiedSerdeFiles.push(filePath);
          }
        })
      );

      return verifiedSerdeFiles.sort();
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
