#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Resolve the path to the SWC workflow plugin.
 * This works because @workflow/nest has @workflow/swc-plugin as a dependency.
 */
function resolveSwcPluginPath(): string {
  return require.resolve('@workflow/swc-plugin', {
    paths: [__dirname],
  });
}

/**
 * Generate .swcrc configuration for NestJS with the workflow plugin.
 */
function generateSwcrc(
  pluginPath: string,
  moduleType: 'es6' | 'commonjs' = 'es6'
): object {
  return {
    $schema: 'https://swc.rs/schema.json',
    jsc: {
      parser: {
        syntax: 'typescript',
        decorators: true,
      },
      transform: {
        legacyDecorator: true,
        decoratorMetadata: true,
      },
      experimental: {
        plugins: [[pluginPath, { mode: 'client' }]],
      },
    },
    module: {
      type: moduleType,
    },
    sourceMaps: true,
  };
}

function showHelp(): void {
  console.log(`
@workflow/nest CLI

Commands:
  init    Generate .swcrc configuration with the workflow plugin
  help    Show this help message

Usage:
  npx @workflow/nest init [options]

Options:
  --module <type>  SWC module type: 'es6' (default) or 'commonjs'
  --force          Overwrite existing .swcrc file

This command generates a .swcrc file configured with the Workflow SWC plugin
for client-mode transformations. The plugin path is resolved from the
@workflow/nest package, so no additional hoisting configuration is needed.
`);
}

function hasWorkflowPlugin(swcrcContent: string): boolean {
  try {
    const parsed = JSON.parse(swcrcContent);
    const plugins = parsed?.jsc?.experimental?.plugins;
    return (
      Array.isArray(plugins) &&
      plugins.some(
        (p) =>
          Array.isArray(p) &&
          typeof p[0] === 'string' &&
          p[0].includes('workflow')
      )
    );
  } catch {
    return false;
  }
}

import { parseModuleType as parseModuleTypeRaw } from './parse-module-type.js';

function parseModuleType(args: string[]): 'es6' | 'commonjs' {
  const result = parseModuleTypeRaw(args);
  if (result === null) {
    const idx = args.indexOf('--module');
    const value = idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
    console.error(
      `Invalid module type: ${value}. Must be 'es6' or 'commonjs'.`
    );
    process.exit(1);
  }
  return result;
}

function handleInit(args: string[]): void {
  const swcrcPath = resolve(process.cwd(), '.swcrc');
  const forceMode = args.includes('--force');
  const moduleType = parseModuleType(args);

  if (existsSync(swcrcPath)) {
    const existing = readFileSync(swcrcPath, 'utf-8');

    if (hasWorkflowPlugin(existing)) {
      console.log('✓ .swcrc already configured with workflow plugin');
      if (!forceMode) {
        console.log('  Run with --force to regenerate');
        process.exit(0);
      }
    } else if (!forceMode) {
      console.log('⚠ .swcrc already exists. Run with --force to overwrite.');
      process.exit(1);
    }
  }

  const pluginPath = resolveSwcPluginPath();
  const swcrc = generateSwcrc(pluginPath, moduleType);

  writeFileSync(swcrcPath, `${JSON.stringify(swcrc, null, 2)}\n`);
  console.log('✓ Created .swcrc with workflow plugin configuration');
  console.log(`  Plugin path: ${pluginPath}`);
  console.log('\nNext steps:');
  console.log(
    '1. Ensure nest-cli.json has: "compilerOptions": { "builder": "swc" }'
  );
  console.log('2. Add .swcrc to .gitignore (it contains absolute paths)');
  console.log('3. Run: nest build');
}

/**
 * Main CLI entry point.
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    showHelp();
    process.exit(0);
  }

  if (command === 'init') {
    handleInit(args);
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run with --help for usage information.');
  process.exit(1);
}

main();
