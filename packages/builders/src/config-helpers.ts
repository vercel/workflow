import { readFile } from 'node:fs/promises';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import type { WorkflowConfig } from './types.js';

export interface DecoratorOptions {
  decorators: boolean;
  legacyDecorator: boolean;
  decoratorMetadata: boolean;
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
  const tsconfigPath = await findUp(['tsconfig.json', 'jsconfig.json'], {
    cwd,
  });
  return getDecoratorOptionsFromTsConfig(tsconfigPath);
}

/**
 * Creates a partial configuration for builders that don't use bundle paths directly.
 * Used by framework integrations like Nitro where the builder computes paths internally.
 */
export function createBaseBuilderConfig(options: {
  workingDir: string;
  dirs?: string[];
  watch?: boolean;
  externalPackages?: string[];
}): Omit<WorkflowConfig, 'buildTarget'> {
  return {
    dirs: options.dirs ?? ['workflows'],
    workingDir: options.workingDir,
    watch: options.watch,
    stepsBundlePath: '', // Not used by base builder methods
    workflowsBundlePath: '', // Not used by base builder methods
    webhookBundlePath: '', // Not used by base builder methods
    externalPackages: options.externalPackages,
  };
}
