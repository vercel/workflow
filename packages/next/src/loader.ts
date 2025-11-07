import { relative } from 'node:path';
import { transform } from '@swc/core';

// Minimal webpack loader context type
interface LoaderContext {
  resourcePath: string;
  async(): (
    err: Error | null,
    content?: string | Buffer,
    sourceMap?: any
  ) => void;
}

// This loader applies the "use workflow"/"use step"
// client transformation
export default function workflowLoader(
  this: LoaderContext,
  source: string | Buffer,
  sourceMap: any
) {
  const callback = this.async();
  if (!callback) {
    throw new Error('Workflow loader requires async support');
  }

  const filename = this.resourcePath;
  const normalizedSource = source.toString();

  // only apply the transform if file needs it
  if (!normalizedSource.match(/(use step|use workflow)/)) {
    // Pass through to the next loader without transformation
    return callback(null, source, sourceMap);
  }

  processWorkflowFile.call(
    this,
    normalizedSource,
    filename,
    sourceMap,
    callback
  );
}

async function processWorkflowFile(
  this: LoaderContext,
  normalizedSource: string,
  filename: string,
  sourceMap: any,
  callback: (
    err: Error | null,
    content?: string | Buffer,
    sourceMap?: any
  ) => void
) {
  try {
    const isTypeScript = filename.endsWith('.ts') || filename.endsWith('.tsx');
    const isTsx = filename.endsWith('.tsx');

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

    // Transform with SWC
    const result = await transform(normalizedSource, {
      filename: relativeFilename,
      jsc: {
        parser: {
          syntax: isTypeScript ? 'typescript' : 'ecmascript',
          tsx: isTsx,
        },
        target: 'es2022',
        experimental: {
          plugins: [
            [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
          ],
        },
      },
      minify: false,
      inputSourceMap: sourceMap,
      sourceMaps: true,
      inlineSourcesContent: true,
    });

    callback(null, result.code, result.map);
  } catch (error) {
    callback(error as Error);
  }
}
