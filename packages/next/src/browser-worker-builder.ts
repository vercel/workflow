/**
 * Browser Worker Builder
 *
 * Bundles browser workflow files into a SharedWorker script for Next.js
 * using esbuild to create a self-contained bundle with all dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { transform } from '@swc/core';
import * as esbuild from 'esbuild';
import type { BrowserWorkflowConfig } from './index.js';

export interface BrowserWorkerBuilderOptions {
  /** Glob patterns for browser workflow files */
  include: string[];
  /** Working directory */
  workingDir: string;
  /** Output directory (typically .next/static) */
  outputDir: string;
  /** Database path for browser storage */
  database?: string;
}

interface WorkflowMetadata {
  workflowId: string;
  functionName: string;
}

interface TransformedWorkflow {
  code: string;
  workflows: WorkflowMetadata[];
  path: string;
  relativePath: string;
}

/**
 * Simple glob pattern matcher
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob pattern to regex by processing character by character
  let regexStr = '';
  let i = 0;

  while (i < normalizedPattern.length) {
    const char = normalizedPattern[i];
    const nextChar = normalizedPattern[i + 1];

    if (char === '*' && nextChar === '*') {
      // Handle **
      if (normalizedPattern[i + 2] === '/') {
        // **/ - match any path segment (including none)
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        // ** at end - match anything
        regexStr += '.*';
        i += 2;
      }
    } else if (char === '*') {
      // Single * - match anything except /
      regexStr += '[^/]*';
      i++;
    } else if (char === '?') {
      // ? - match single char except /
      regexStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      // Escape regex special chars
      regexStr += '\\' + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalizedPath);
}

/**
 * Find all files matching the browser workflow patterns
 */
function findBrowserWorkflowFiles(
  dir: string,
  patterns: string[],
  baseDir: string
): string[] {
  const files: string[] = [];

  function walkDir(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
          walkDir(fullPath);
        }
      } else if (entry.isFile()) {
        // Check if file matches any pattern
        if (patterns.some((pattern) => matchGlob(relativePath, pattern))) {
          files.push(fullPath);
        }
      }
    }
  }

  if (fs.existsSync(dir)) {
    walkDir(dir);
  }

  return files;
}

/**
 * Transform a workflow file and extract all workflow metadata
 */
async function transformWorkflowFile(
  filePath: string,
  workingDir: string
): Promise<TransformedWorkflow | null> {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Only process files with workflow directives
  if (
    !content.includes("'use workflow'") &&
    !content.includes('"use workflow"')
  ) {
    return null;
  }

  const relativePath = path.relative(workingDir, filePath).replace(/\\/g, '/');
  const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

  // Transform with workflow mode to get the actual workflow code that can be executed
  // (workflow mode keeps the function body, step mode replaces it with a guard)
  const result = await transform(content, {
    filename: relativePath,
    jsc: {
      parser: {
        syntax: isTypeScript ? 'typescript' : 'ecmascript',
        tsx: filePath.endsWith('.tsx'),
      },
      target: 'es2022',
      experimental: {
        plugins: [
          [require.resolve('@workflow/swc-plugin'), { mode: 'workflow' }],
        ],
      },
    },
    minify: false,
    sourceMaps: false,
  });

  // Extract workflow metadata from the comment
  const metadataMatch = result.code.match(
    /\/\*\*__internal_workflows(\{.*?\})\*\//
  );
  if (!metadataMatch) {
    return null;
  }

  try {
    const metadata = JSON.parse(metadataMatch[1]);
    const workflowsForFile = metadata.workflows?.[relativePath];
    if (!workflowsForFile || Object.keys(workflowsForFile).length === 0) {
      return null;
    }

    // Extract all workflow function names and their IDs
    const workflows: WorkflowMetadata[] = Object.entries(workflowsForFile).map(
      ([functionName, data]) => ({
        functionName,
        workflowId: (data as { workflowId: string }).workflowId,
      })
    );

    return {
      code: result.code,
      workflows,
      path: filePath,
      relativePath,
    };
  } catch {
    return null;
  }
}

/**
 * Generate a browser-compatible shim for workflow/internal/private
 * This replaces the Node.js-specific code with browser-safe implementations.
 */
function generatePrivateShim(): string {
  return `/**
 * Browser-compatible shim for workflow/internal/private
 * This provides step registration without Node.js dependencies.
 */

const registeredSteps = new Map();

export function registerStepFunction(stepId, stepFn) {
  registeredSteps.set(stepId, stepFn);
}

export function getStepFunction(stepId) {
  return registeredSteps.get(stepId);
}

// Browser shim for __private_getClosureVars
// In the browser, closure variables are handled differently
export function __private_getClosureVars() {
  // Return empty object - browser workflows don't use the same closure mechanism
  return {};
}
`;
}

/**
 * Generate the SharedWorker entry point code
 */
function generateWorkerEntryCode(
  transformedWorkflows: TransformedWorkflow[],
  database: string
): string {
  // Generate imports for each workflow file
  const workflowImports = transformedWorkflows
    .map((tw, index) => {
      const exports = tw.workflows.map((w) => w.functionName).join(', ');
      return `import { ${exports} } from './workflow_${index}.js';`;
    })
    .join('\n');

  // Generate registry entries
  const registryEntries = transformedWorkflows
    .flatMap((tw) =>
      tw.workflows.map(
        (w) => `workflowRegistry.set('${w.workflowId}', ${w.functionName});`
      )
    )
    .join('\n  ');

  return `/**
 * Auto-generated SharedWorker bundle for browser workflows
 * Generated at: ${new Date().toISOString()}
 */

import { createBrowserWorld } from '@workflow/world-browser';
import { startQueueProcessor } from '@workflow/world-browser';
import { executeWorkflow, setWorkflowRegistry } from '@workflow/world-browser/worker';

// Import workflow functions
${workflowImports}

// Workflow registry
const workflowRegistry = new Map();
${registryEntries}

// Set the registry for the worker module
setWorkflowRegistry(workflowRegistry);

// Worker state
let world = null;
const subscriptions = new Map();

// Broadcast to subscribers (posts to main thread)
function broadcastToSubscribers(runId, event) {
  const callbacks = subscriptions.get(runId);
  if (callbacks) {
    // Post the event to the main thread
    self.postMessage(event);
  }
}

console.log('[browser-worker] Worker loaded, initializing...');

// Initialize world immediately
let worldReady = (async () => {
  console.log('[browser-worker] Initializing world...');
  try {
    world = await createBrowserWorld({ database: '${database}' });
    console.log('[browser-worker] World initialized successfully');
    
    // Start queue processor
    startQueueProcessor(world.db, {
      workflow: async (message, meta) => {
        if (!('runId' in message)) return;

        const run = await world.runs.get(message.runId);
        const workflowFn = workflowRegistry.get(run.workflowName);

        if (!workflowFn) {
          console.error('[browser-worker] Workflow not found:', run.workflowName);
          await world.runs.update(run.runId, {
            status: 'failed',
            error: { message: 'Workflow not found: ' + run.workflowName },
          });
          return;
        }

        try {
          // Update status to running
          await world.runs.update(run.runId, { status: 'running' });
          broadcastToSubscribers(run.runId, {
            type: 'RUN_UPDATED',
            runId: run.runId,
            run: await world.runs.get(run.runId),
          });

          // Execute workflow
          const events = await world.events.list({ runId: run.runId });
          const result = await executeWorkflow(workflowFn, run, events.data, world);

          // Update with result
          const completedRun = await world.runs.update(run.runId, {
            status: 'completed',
            output: result,
          });

          broadcastToSubscribers(run.runId, {
            type: 'RUN_COMPLETED',
            runId: run.runId,
            run: completedRun,
          });
        } catch (error) {
          const failedRun = await world.runs.update(run.runId, {
            status: 'failed',
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          });

          broadcastToSubscribers(run.runId, {
            type: 'RUN_FAILED',
            runId: run.runId,
            run: failedRun,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      step: async () => {
        // Step execution is handled within workflow context
      },
    });
    console.log('[browser-worker] Queue processor started');
    return world;
  } catch (err) {
    console.error('[browser-worker] Failed to initialize world:', err);
    throw err;
  }
})();

// Handle messages from main thread
self.onmessage = async (msgEvent) => {
  const { id, type, ...payload } = msgEvent.data;
  console.log('[browser-worker] Received message:', type, id);

  // Wait for world to be ready before handling messages
  try {
    await worldReady;
  } catch (err) {
    self.postMessage({
      id,
      success: false,
      error: 'Worker initialization failed: ' + (err instanceof Error ? err.message : String(err)),
    });
    return;
  }

  try {
    let result;

      switch (type) {
        case 'TRIGGER': {
          const run = await world.runs.create({
            workflowName: payload.workflowId,
            deploymentId: 'browser',
            input: payload.args,
          });
          await world.queue('__wkf_workflow_' + payload.workflowId, { runId: run.runId });
          result = { runId: run.runId };
          break;
        }

        case 'GET_STATUS': {
          result = await world.runs.get(payload.runId);
          break;
        }

        case 'LIST_RUNS': {
          result = await world.runs.list({
            workflowName: payload.workflowName,
            status: payload.status,
            pagination: {
              limit: payload.limit,
              cursor: payload.cursor,
            },
          });
          break;
        }

        case 'CANCEL': {
          result = await world.runs.cancel(payload.runId);
          broadcastToSubscribers(payload.runId, {
            type: 'RUN_UPDATED',
            runId: payload.runId,
            run: result,
          });
          break;
        }

        case 'PAUSE': {
          result = await world.runs.pause(payload.runId);
          broadcastToSubscribers(payload.runId, {
            type: 'RUN_UPDATED',
            runId: payload.runId,
            run: result,
          });
          break;
        }

        case 'RESUME': {
          result = await world.runs.resume(payload.runId);
          broadcastToSubscribers(payload.runId, {
            type: 'RUN_UPDATED',
            runId: payload.runId,
            run: result,
          });
          // Re-queue for execution
          await world.queue('__wkf_workflow_' + result.workflowName, { runId: result.runId });
          break;
        }

        case 'SUBSCRIBE': {
          if (!subscriptions.has(payload.runId)) {
            subscriptions.set(payload.runId, true);
          }
          result = await world.runs.get(payload.runId);
          break;
        }

        case 'UNSUBSCRIBE': {
          subscriptions.delete(payload.runId);
          result = null;
          break;
        }

        case 'GET_STEPS': {
          result = await world.steps.list({ runId: payload.runId });
          break;
        }

        case 'GET_EVENTS': {
          result = await world.events.list({ runId: payload.runId });
          break;
        }

        default:
          result = { error: 'Unknown request type: ' + type };
      }

      self.postMessage({ id, success: true, data: result });
    } catch (error) {
      self.postMessage({
        id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
};
`;
}

/**
 * Generate the SharedWorker bundle using esbuild
 */
export async function buildBrowserWorker(
  options: BrowserWorkerBuilderOptions
): Promise<void> {
  const { include, workingDir, outputDir, database = 'workflows.db' } = options;

  // Find all browser workflow files
  const workflowFiles = findBrowserWorkflowFiles(
    workingDir,
    include,
    workingDir
  );

  if (workflowFiles.length === 0) {
    console.log('[browser-worker] No browser workflow files found');
    return;
  }

  console.log(
    `[browser-worker] Found ${workflowFiles.length} browser workflow files`
  );

  // Transform each workflow file
  const transformedWorkflows: TransformedWorkflow[] = [];

  for (const filePath of workflowFiles) {
    const result = await transformWorkflowFile(filePath, workingDir);
    if (result) {
      transformedWorkflows.push(result);
    }
  }

  if (transformedWorkflows.length === 0) {
    console.log('[browser-worker] No workflows to bundle');
    return;
  }

  console.log(
    `[browser-worker] Bundling ${transformedWorkflows.reduce((acc, tw) => acc + tw.workflows.length, 0)} workflows`
  );

  // Create a temporary directory for the build
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-browser-'));

  // Map temp file names to original source directories for import resolution
  const tempToOriginalDir = new Map<string, string>();

  try {
    // Write the browser-compatible private shim
    const shimPath = path.join(tmpDir, 'workflow-private-shim.js');
    fs.writeFileSync(shimPath, generatePrivateShim(), 'utf-8');

    // Write each transformed workflow file and track original paths
    for (let i = 0; i < transformedWorkflows.length; i++) {
      const tw = transformedWorkflows[i];
      const workflowFilePath = path.join(tmpDir, `workflow_${i}.js`);
      fs.writeFileSync(workflowFilePath, tw.code, 'utf-8');
      // Map temp file to original source directory
      tempToOriginalDir.set(workflowFilePath, path.dirname(tw.path));
    }

    // Generate and write the entry file
    const entryCode = generateWorkerEntryCode(transformedWorkflows, database);
    const entryPath = path.join(tmpDir, 'worker-entry.js');
    fs.writeFileSync(entryPath, entryCode, 'utf-8');

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Output directly to public folder with the expected filename
    const workerPath = path.join(outputDir, '__workflow-worker.js');

    // Create esbuild plugin to resolve relative imports from original source locations
    const resolveFromOriginalPlugin: esbuild.Plugin = {
      name: 'resolve-from-original',
      setup(build) {
        // Intercept relative imports in temp workflow files
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          // Check if this import is from a temp workflow file
          const importerDir = tempToOriginalDir.get(args.importer);
          if (importerDir) {
            // Resolve relative to the original source directory
            const resolvedPath = path.resolve(importerDir, args.path);
            // Try with .ts, .tsx, .js extensions
            const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];
            for (const ext of extensions) {
              const fullPath = resolvedPath + ext;
              if (fs.existsSync(fullPath)) {
                return { path: fullPath };
              }
              // Also try /index variants
              const indexPath = path.join(resolvedPath, `index${ext || '.ts'}`);
              if (fs.existsSync(indexPath)) {
                return { path: indexPath };
              }
            }
          }
          return undefined; // Let esbuild handle it normally
        });
      },
    };

    // Bundle with esbuild
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      outfile: workerPath,
      minify: false,
      sourcemap: false,
      // Bundle all dependencies into the worker
      external: [],
      // Define environment
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      // Use plugin to resolve relative imports from original locations
      plugins: [resolveFromOriginalPlugin],
      // Handle node: protocol imports
      platform: 'browser',
      // Log level
      logLevel: 'warning',
      // Resolve modules from the working directory's node_modules
      nodePaths: [
        path.join(workingDir, 'node_modules'),
        // Also check monorepo root node_modules
        path.resolve(workingDir, '../../node_modules'),
      ],
      // Set absWorkingDir so relative imports in temp files work
      absWorkingDir: workingDir,
      // Alias workflow/internal/private to our browser-compatible shim
      alias: {
        'workflow/internal/private': shimPath,
      },
    });

    console.log(`[browser-worker] Generated worker bundle at ${workerPath}`);

    // Copy Turso WASM file to output directory
    try {
      const tursoWasmPath = require.resolve(
        '@tursodatabase/database-wasm/dist/turso.wasm32-wasi.wasm'
      );
      const destWasmPath = path.join(outputDir, 'turso.wasm32-wasi.wasm');
      fs.copyFileSync(tursoWasmPath, destWasmPath);
      console.log(`[browser-worker] Copied Turso WASM to ${destWasmPath}`);
    } catch (err) {
      console.warn(
        '[browser-worker] Could not copy Turso WASM file:',
        err instanceof Error ? err.message : err
      );
    }
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create browser worker builder from config
 */
export function createBrowserWorkerBuilder(
  config: BrowserWorkflowConfig,
  workingDir: string,
  outputDir: string
) {
  return {
    async build() {
      await buildBrowserWorker({
        include: config.include,
        workingDir,
        outputDir,
        database: config.database,
      });
    },
  };
}
