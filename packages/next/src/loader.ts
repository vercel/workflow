import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { transform } from '@swc/core';

type DecoratorOptionsWithConfigPath =
  import('@workflow/builders').DecoratorOptionsWithConfigPath;
type WorkflowPatternMatch = import('@workflow/builders').WorkflowPatternMatch;

// Cache decorator options per working directory to avoid reading tsconfig for every file
const decoratorOptionsCache = new Map<
  string,
  Promise<DecoratorOptionsWithConfigPath>
>();
// Cache for shared utilities from @workflow/builders (ESM module loaded dynamically in CommonJS context)
let cachedBuildersModule: typeof import('@workflow/builders') | null = null;
type LoaderStaticDependencies = {
  swcPluginPath: string;
  files: string[];
};
let cachedLoaderStaticDependencies: LoaderStaticDependencies | null = null;

function registerFileDependency(
  loaderContext: WorkflowLoaderContext,
  dependencyPath: string
): void {
  loaderContext.addDependency?.(dependencyPath);
  loaderContext.addBuildDependency?.(dependencyPath);
}

function addIfExists(files: Set<string>, dependencyPath: string): void {
  if (existsSync(dependencyPath)) {
    files.add(dependencyPath);
  }
}

function resolveLoaderStaticDependencies(): LoaderStaticDependencies {
  if (cachedLoaderStaticDependencies) {
    return cachedLoaderStaticDependencies;
  }

  const swcPluginPath = require.resolve('@workflow/swc-plugin');
  const swcPluginBuildHashPath = require.resolve(
    '@workflow/swc-plugin/build-hash.json'
  );
  const workflowBuildersPath = require.resolve('@workflow/builders');

  // Derive package.json paths from resolved entrypoints to avoid
  // Turbopack loader-eval failures around ../package.json resolution.
  const swcPluginPackageJsonPath = join(dirname(swcPluginPath), 'package.json');
  const workflowBuildersPackageJsonPath = join(
    dirname(workflowBuildersPath),
    '../package.json'
  );

  const files = new Set<string>([
    __filename,
    swcPluginPath,
    swcPluginBuildHashPath,
    workflowBuildersPath,
  ]);
  addIfExists(files, swcPluginPackageJsonPath);
  addIfExists(files, workflowBuildersPackageJsonPath);

  cachedLoaderStaticDependencies = {
    swcPluginPath,
    files: Array.from(files),
  };
  return cachedLoaderStaticDependencies;
}

function registerTransformDependencies(
  loaderContext: WorkflowLoaderContext
): string {
  const staticDependencies = resolveLoaderStaticDependencies();
  for (const dependencyPath of staticDependencies.files) {
    registerFileDependency(loaderContext, dependencyPath);
  }

  return staticDependencies.swcPluginPath;
}

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
): Promise<DecoratorOptionsWithConfigPath> {
  const cached = decoratorOptionsCache.get(workingDir);
  if (cached) {
    return cached;
  }

  const promise = (async (): Promise<DecoratorOptionsWithConfigPath> => {
    const { getDecoratorOptionsForDirectoryWithConfigPath } =
      await getBuildersModule();
    return getDecoratorOptionsForDirectoryWithConfigPath(workingDir);
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

async function resolveWorkflowAliasPath(
  filePath: string,
  workingDir: string
): Promise<string | undefined> {
  const { resolveWorkflowAliasRelativePath } = await getBuildersModule();
  return resolveWorkflowAliasRelativePath(filePath, workingDir);
}

async function getRelativeFilenameForSwc(
  filename: string,
  workingDir: string
): Promise<string> {
  const normalizedWorkingDir = workingDir
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  const normalizedFilepath = filename.replace(/\\/g, '/');

  // Windows fix: Use case-insensitive comparison to work around drive letter casing issues
  const lowerWd = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedFilepath.toLowerCase();

  let relativeFilename: string;
  if (lowerPath.startsWith(`${lowerWd}/`)) {
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
      const aliasedRelativePath = await resolveWorkflowAliasPath(
        filename,
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

  // Final safety check - ensure we never pass an absolute path to SWC
  if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
    // This should rarely happen, but use filename split as last resort
    relativeFilename = normalizedFilepath.split('/').pop() || 'unknown.ts';
  }

  return relativeFilename;
}

// This loader applies the "use workflow"/"use step" transform.
// All files use step mode; the SWC plugin decides per-function whether
// to emit workflow or step bindings based on the source's directives.
type WorkflowLoaderContext = {
  resourcePath: string;
  async?: () => (
    error: Error | null,
    content?: string,
    sourceMap?: any
  ) => void;
  addDependency?: (dependency: string) => void;
  addBuildDependency?: (dependency: string) => void;
};

export default function workflowLoader(
  this: WorkflowLoaderContext,
  source: string | Buffer,
  sourceMap: any
): string | Promise<string> | void {
  const callback = this.async?.();
  const run = async (): Promise<{ code: string; map: any }> => {
    const filename = this.resourcePath;
    const normalizedSource = source.toString();
    const workingDir = process.cwd();
    const swcPluginPath = registerTransformDependencies(this);
    const sourceForTransform = normalizedSource;

    const isGeneratedWorkflowFile = await checkGeneratedFile(filename);
    // Skip generated workflow route files to avoid re-processing them.
    if (isGeneratedWorkflowFile) {
      return { code: normalizedSource, map: sourceMap };
    }

    // Detect workflow patterns in the source code.
    const patterns = await detectPatterns(sourceForTransform);

    // Check if file needs transformation based on patterns and path
    if (!(await checkShouldTransform(filename, patterns))) {
      return { code: normalizedSource, map: sourceMap };
    }

    const isTypeScript =
      filename.endsWith('.ts') ||
      filename.endsWith('.tsx') ||
      filename.endsWith('.mts') ||
      filename.endsWith('.cts');

    // Calculate relative filename for SWC plugin
    // The SWC plugin uses filename to generate workflowId, so it must be relative
    const relativeFilename = await getRelativeFilenameForSwc(
      filename,
      workingDir
    );

    // Get decorator options from tsconfig (cached per working directory)
    const { options: decoratorOptions, configPath } =
      await getDecoratorOptions(workingDir);
    if (configPath) {
      registerFileDependency(this, configPath);
    }

    // Resolve module specifier for packages (node_modules or workspace packages)
    const moduleSpecifier = await getModuleSpecifier(filename, workingDir);
    const mode = 'step';

    // Transform with SWC
    const result = await transform(sourceForTransform, {
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
          cacheRoot: join(workingDir, '.swc'),
          plugins: [[swcPluginPath, { mode, moduleSpecifier }]],
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

    let transformedMap = sourceMap;
    if (typeof result.map === 'string') {
      try {
        transformedMap = JSON.parse(result.map);
      } catch {
        transformedMap = result.map;
      }
    } else if (result.map) {
      transformedMap = result.map;
    }

    return { code: result.code, map: transformedMap };
  };

  if (!callback) {
    return run().then((result) => result.code);
  }

  void run()
    .then((result) => callback(null, result.code, result.map))
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)));
    });
}
