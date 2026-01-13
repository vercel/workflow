import { relative } from 'node:path';
import { transform } from '@swc/core';

type DecoratorOptions = import('@workflow/builders').DecoratorOptions;

// Cache decorator options per working directory to avoid reading tsconfig for every file
const decoratorOptionsCache = new Map<string, Promise<DecoratorOptions>>();

async function getDecoratorOptions(
  workingDir: string
): Promise<DecoratorOptions> {
  const cached = decoratorOptionsCache.get(workingDir);
  if (cached) {
    return cached;
  }

  const promise = (async (): Promise<DecoratorOptions> => {
    // Dynamic import to handle ESM module from CommonJS context
    // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript from transpiling the import statement into `require()`
    const { getDecoratorOptionsForDirectory } = (await eval(
      'import("@workflow/builders")'
    )) as typeof import('@workflow/builders');

    return getDecoratorOptionsForDirectory(workingDir);
  })();

  decoratorOptionsCache.set(workingDir, promise);
  return promise;
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

  // only apply the transform if file needs it
  if (!normalizedSource.match(/(use step|use workflow)/)) {
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
          [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
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
