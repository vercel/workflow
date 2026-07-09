import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import type { SourcemapMode, WorkflowConfig } from './types.js';

export interface DecoratorOptions {
  decorators: boolean;
  legacyDecorator: boolean;
  decoratorMetadata: boolean;
}

export interface DecoratorOptionsWithConfigPath {
  options: DecoratorOptions;
  configPath: string | undefined;
}

/**
 * Reads tsconfig.json and extracts decorator-related compiler options.
 * Returns decorator options based on experimentalDecorators and emitDecoratorMetadata settings.
 *
 * @param tsconfigPath - Path to tsconfig.json or jsconfig.json
 * @returns DecoratorOptions with settings based on tsconfig compilerOptions
 */
export async function getDecoratorOptionsFromTsConfig(
  tsconfigPath: string | undefined
): Promise<DecoratorOptions> {
  const defaultOptions: DecoratorOptions = {
    decorators: false,
    legacyDecorator: false,
    decoratorMetadata: false,
  };

  if (!tsconfigPath) {
    return defaultOptions;
  }

  try {
    const content = await readFile(tsconfigPath, 'utf-8');
    const tsconfig: { compilerOptions?: Record<string, unknown> } =
      JSON5.parse(content);
    const compilerOptions = tsconfig.compilerOptions || {};

    // Match Next.js behavior: enable decorators only when experimentalDecorators is true
    const experimentalDecorators =
      compilerOptions.experimentalDecorators === true;
    const emitDecoratorMetadata =
      compilerOptions.emitDecoratorMetadata === true;

    return {
      decorators: experimentalDecorators,
      legacyDecorator: experimentalDecorators,
      decoratorMetadata: experimentalDecorators && emitDecoratorMetadata,
    };
  } catch {
    // If we can't read or parse the tsconfig, return defaults
    return defaultOptions;
  }
}

/**
 * Finds tsconfig.json in the given directory (or ancestors) and extracts decorator options.
 * Combines tsconfig discovery with decorator option extraction for convenience.
 *
 * @param cwd - Directory to start searching for tsconfig.json
 * @returns DecoratorOptions with settings based on tsconfig compilerOptions
 */
export async function getDecoratorOptionsForDirectory(
  cwd: string
): Promise<DecoratorOptions> {
  const { options } = await getDecoratorOptionsForDirectoryWithConfigPath(cwd);
  return options;
}

/**
 * Finds tsconfig.json/jsconfig.json in the given directory tree and returns
 * both decorator options and the config path used to derive them.
 */
export async function getDecoratorOptionsForDirectoryWithConfigPath(
  cwd: string
): Promise<DecoratorOptionsWithConfigPath> {
  const configPath = await findUp(['tsconfig.json', 'jsconfig.json'], {
    cwd,
  });
  const options = await getDecoratorOptionsFromTsConfig(configPath);
  return { options, configPath };
}

/**
 * Creates a partial configuration for builders that don't use bundle paths directly.
 * Used by framework integrations like Nitro where the builder computes paths internally.
 */
export function createBaseBuilderConfig(options: {
  workingDir: string;
  projectRoot?: string;
  dirs?: string[];
  watch?: boolean;
  externalPackages?: string[];
  runtime?: string;
  sourcemap?: SourcemapMode;
}): Omit<WorkflowConfig, 'buildTarget'> {
  return {
    dirs: options.dirs ?? ['workflows'],
    projectRoot: options.projectRoot,
    workingDir: options.workingDir,
    watch: options.watch,
    stepsBundlePath: '', // Not used by base builder methods
    workflowsBundlePath: '', // Not used by base builder methods
    webhookBundlePath: '', // Not used by base builder methods
    externalPackages: options.externalPackages,
    runtime: options.runtime,
    sourcemap: options.sourcemap,
  };
}

const WORKSPACE_ROOT_FILES = ['pnpm-workspace.yaml'];
const PROJECT_ROOT_FILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findRootFile(names: string[], workingDir: string): string | undefined {
  let current = resolve(workingDir);

  while (true) {
    for (const name of names) {
      const file = join(current, name);
      if (fileExists(file)) {
        return file;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function findProjectRootFile(workingDir: string): string | undefined {
  return (
    findRootFile(WORKSPACE_ROOT_FILES, workingDir) ??
    findRootFile(PROJECT_ROOT_FILES, workingDir)
  );
}

export function resolveConfiguredProjectRoot(
  workingDir: string,
  configuredRoot: string
): string {
  return isAbsolute(configuredRoot)
    ? configuredRoot
    : resolve(workingDir, configuredRoot);
}

export function resolveProjectRoot(workingDir: string): string {
  let rootFile = findProjectRootFile(workingDir);
  if (!rootFile) {
    return resolve(workingDir);
  }

  while (true) {
    const currentDir = dirname(rootFile);
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return currentDir;
    }

    const parentRootFile = findProjectRootFile(parentDir);
    if (!parentRootFile) {
      return currentDir;
    }
    rootFile = parentRootFile;
  }
}
