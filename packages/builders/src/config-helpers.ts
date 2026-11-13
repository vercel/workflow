import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import {
  getTsconfigExtendsSpecifiers,
  resolveTsconfigExtendsPath,
} from './tsconfig-extends.js';
import type { SourcemapMode, WorkflowConfig } from './types.js';

export interface DecoratorOptions {
  decorators: boolean;
  legacyDecorator: boolean;
  decoratorMetadata: boolean;
}

export interface DecoratorOptionsWithConfigPath {
  options: DecoratorOptions;
  configPath: string | undefined;
  /** Every config file read to derive `options`: `configPath` and its `extends` bases. */
  configPaths: string[];
}

/**
 * Reads tsconfig.json and extracts decorator-related compiler options.
 * Returns decorator options based on experimentalDecorators and emitDecoratorMetadata settings.
 *
 * @param tsconfigPath - Path to tsconfig.json or jsconfig.json
 * @returns DecoratorOptions with settings based on tsconfig compilerOptions
 */
export async function getDecoratorOptionsFromTsConfig(
  tsconfigPath: string | undefined,
  configPaths = new Set<string>()
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
    const compilerOptions = await readEffectiveCompilerOptions(
      resolve(tsconfigPath),
      new Set(),
      configPaths
    );

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
 * Reads `compilerOptions` merged through `extends` as TypeScript does: bases
 * first, in order, then the config's own options. Stops on circular extends.
 */
async function readEffectiveCompilerOptions(
  tsconfigPath: string,
  ancestors: Set<string>,
  configPaths: Set<string>
): Promise<Record<string, unknown>> {
  if (ancestors.has(tsconfigPath)) {
    return {};
  }

  configPaths.add(tsconfigPath);
  const content = await readFile(tsconfigPath, 'utf-8');
  const tsconfig: {
    extends?: unknown;
    compilerOptions?: Record<string, unknown>;
  } = JSON5.parse(content);

  ancestors.add(tsconfigPath);
  try {
    const merged: Record<string, unknown> = {};
    for (const specifier of getTsconfigExtendsSpecifiers(tsconfig.extends)) {
      const basePath = await resolveTsconfigExtendsPath(
        specifier,
        tsconfigPath
      );
      if (!basePath) {
        continue;
      }
      try {
        Object.assign(
          merged,
          await readEffectiveCompilerOptions(
            resolve(basePath),
            ancestors,
            configPaths
          )
        );
      } catch {
        // An unreadable base contributes nothing.
      }
    }
    return Object.assign(merged, tsconfig.compilerOptions);
  } finally {
    ancestors.delete(tsconfigPath);
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
  const configPaths = new Set<string>();
  const options = await getDecoratorOptionsFromTsConfig(
    configPath,
    configPaths
  );
  return { options, configPath, configPaths: [...configPaths] };
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
