import { relative } from 'node:path';
import { transform } from '@swc/core';

type DecoratorOptions = import('@workflow/builders').DecoratorOptions;
type WorkflowPatternMatch = import('@workflow/builders').WorkflowPatternMatch;

// Cache decorator options per working directory to avoid reading tsconfig for every file
const decoratorOptionsCache = new Map<string, Promise<DecoratorOptions>>();

// Cache for shared utilities from @workflow/builders (ESM module loaded dynamically in CommonJS context)
let cachedBuildersModule: typeof import('@workflow/builders') | null = null;

async function getBuildersModule(): Promise<
  typeof import('@workflow/builders')
> {
  if (cachedBuildersModule) {
    return cachedBuildersModule;
  }
  // Dynamic import to handle ESM module from CommonJS context
  // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript from transpiling the import statement into `require()`
  cachedBuildersModule = (await eval(
    'import("@workflow/builders")'
  )) as typeof import('@workflow/builders');
  return cachedBuildersModule;
}

async function getDecoratorOptions(
  workingDir: string
): Promise<DecoratorOptions> {
  const cached = decoratorOptionsCache.get(workingDir);
  if (cached) {
    return cached;
  }

  const promise = (async (): Promise<DecoratorOptions> => {
    const { getDecoratorOptionsForDirectory } = await getBuildersModule();
    return getDecoratorOptionsForDirectory(workingDir);
  })();

  decoratorOptionsCache.set(workingDir, promise);
  return promise;
}

async function detectPatterns(source: string): Promise<WorkflowPatternMatch> {
  const { detectWorkflowPatterns } = await getBuildersModule();
  return detectWorkflowPatterns(source);
}

async function checkGeneratedFile(filePath: string): Promise<boolean> {
  const { isGeneratedWorkflowFile } = await getBuildersModule();
  return isGeneratedWorkflowFile(filePath);
}

async function checkSdkFile(filePath: string): Promise<boolean> {
  const { isWorkflowSdkFile } = await getBuildersModule();
  return isWorkflowSdkFile(filePath);
}

async function checkShouldTransform(
  filePath: string,
  patterns: WorkflowPatternMatch
): Promise<boolean> {
  const { shouldTransformFile } = await getBuildersModule();
  return shouldTransformFile(filePath, patterns);
}

async function getModuleSpecifier(
  filePath: string,
  projectRoot: string
): Promise<string | undefined> {
  const { resolveModuleSpecifier } = await getBuildersModule();
  return resolveModuleSpecifier(filePath, projectRoot).moduleSpecifier;
}

// This loader applies the "use workflow"/"use step"
// client transformation
export default async function workflowLoader(
  this: {
    resourcePath: string;
  },
  source: string | Buffer,
  sourceMap: any
): Promise<string> {
  const filename = this.resourcePath;
  const normalizedSource = source.toString();

  // Skip generated workflow route files to avoid re-processing them
  if (await checkGeneratedFile(filename)) {
    return normalizedSource;
  }

  // Detect workflow patterns in the source code
  const patterns = await detectPatterns(normalizedSource);

  // For @workflow SDK packages, only transform files with actual directives,
  // not files that just match serde patterns (which are internal SDK implementation files)
  const isSdkFile = await checkSdkFile(filename);
  if (isSdkFile && !patterns.hasDirective) {
    return normalizedSource;
  }

  // Check if file needs transformation based on patterns and path
  if (!(await checkShouldTransform(filename, patterns))) {
    return normalizedSource;
  }

  const isTypeScript =
    filename.endsWith('.ts') ||
    filename.endsWith('.tsx') ||
    filename.endsWith('.mts') ||
    filename.endsWith('.cts');

  // Calculate relative filename for SWC plugin
  // The SWC plugin uses filename to generate workflowId, so it must be relative
  const workingDir = process.cwd();
  const normalizedWorkingDir = workingDir
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  const normalizedFilepath = filename.replace(/\\/g, '/');

  // Windows fix: Use case-insensitive comparison to work around drive letter casing issues
  const lowerWd = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedFilepath.toLowerCase();

  let relativeFilename: string;
  if (lowerPath.startsWith(lowerWd + '/')) {
    // File is under working directory - manually calculate relative path
    relativeFilename = normalizedFilepath.substring(
      normalizedWorkingDir.length + 1
    );
  } else if (lowerPath === lowerWd) {
    // File IS the working directory (shouldn't happen)
    relativeFilename = '.';
  } else {
    // Use relative() for files outside working directory
    relativeFilename = relative(workingDir, filename).replace(/\\/g, '/');

    if (relativeFilename.startsWith('../')) {
      relativeFilename = relativeFilename
        .split('/')
        .filter((part) => part !== '..')
        .join('/');
    }
  }

  // Final safety check - ensure we never pass an absolute path to SWC
  if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
    // This should rarely happen, but use filename split as last resort
    relativeFilename = normalizedFilepath.split('/').pop() || 'unknown.ts';
  }

  // Get decorator options from tsconfig (cached per working directory)
  const decoratorOptions = await getDecoratorOptions(workingDir);

  // Resolve module specifier for packages (node_modules or workspace packages)
  const moduleSpecifier = await getModuleSpecifier(filename, workingDir);

  // Transform with SWC
  const result = await transform(normalizedSource, {
    filename: relativeFilename,
    jsc: {
      parser: {
        ...(isTypeScript
          ? {
              syntax: 'typescript',
              tsx: filename.endsWith('.tsx'),
              decorators: decoratorOptions.decorators,
            }
          : {
              syntax: 'ecmascript',
              jsx: filename.endsWith('.jsx'),
              decorators: decoratorOptions.decorators,
            }),
      },
      target: 'es2022',
      experimental: {
        plugins: [
          [
            require.resolve('@workflow/swc-plugin'),
            { mode: 'client', moduleSpecifier },
          ],
        ],
      },
      transform: {
        react: {
          runtime: 'preserve',
        },
        legacyDecorator: decoratorOptions.legacyDecorator,
        decoratorMetadata: decoratorOptions.decoratorMetadata,
      },
    },
    minify: false,
    inputSourceMap: sourceMap,
    sourceMaps: true,
    inlineSourcesContent: true,
  });

  return result.code;
}
