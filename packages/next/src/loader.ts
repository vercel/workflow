import { relative } from 'node:path';
import { transform } from '@swc/core';

/**
 * Match a file path against a glob pattern.
 * Supports **, *, and ? wildcards.
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
        // **/ matches zero or more directories
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        // ** at end matches everything
        regexStr += '.*';
        i += 2;
      }
    } else if (char === '*') {
      // * matches anything except /
      regexStr += '[^/]*';
      i++;
    } else if (char === '?') {
      // ? matches single char except /
      regexStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      // Escape regex special characters
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
 * Check if a file path matches any of the browser workflow patterns.
 */
function isBrowserWorkflow(filePath: string): boolean {
  const browserInclude = process.env.WORKFLOW_BROWSER_INCLUDE;
  if (!browserInclude) {
    return false;
  }

  try {
    const patterns: string[] = JSON.parse(browserInclude);
    return patterns.some((pattern) => matchGlob(filePath, pattern));
  } catch {
    return false;
  }
}

/**
 * Determine the transform mode for a file.
 */
function getTransformMode(filePath: string): 'client' | 'browser' {
  return isBrowserWorkflow(filePath) ? 'browser' : 'client';
}

// This loader applies the "use workflow"/"use step"
// client/browser transformation
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

  // Determine transform mode based on file path
  const transformMode = getTransformMode(relativeFilename);

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
          [require.resolve('@workflow/swc-plugin'), { mode: transformMode }],
        ],
      },
    },
    minify: false,
    inputSourceMap: sourceMap,
    sourceMaps: true,
    inlineSourcesContent: true,
  });

  return result.code;
}
