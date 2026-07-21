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
        plugins: [[pluginPath, { mode: 'step' }]],
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
  build   Build workflow bundles (and the Vercel Build Output when on Vercel)
  help    Show this help message

Usage:
  npx @workflow/nest init [options]
  npx @workflow/nest build [options]

Init options:
  --module <type>  SWC module type: 'es6' (default) or 'commonjs'
  --force          Overwrite existing .swcrc file

Build options:
  --vercel         Emit a Vercel Build Output API directory (.vercel/output)
                   with the workflow queue-consumer function so runs are
                   dispatched on Vercel. Implied when the VERCEL env var is set.
  --dirs <dirs>    Comma-separated workflow source dirs (default: 'src')
  --entry <path>   Vercel app entry module that default-exports a Node request
                   handler (default: auto-detected, e.g. _vercel/entry.js)
  --out-dir <dir>  Output dir for local dev bundles (default: '.nestjs/workflow')
  --module <type>  SWC module type: 'es6' (default) or 'commonjs'

'init' generates a .swcrc file configured with the Workflow SWC plugin so the
NestJS compiler transforms your workflow/step files. 'build' generates the
workflow bundles for local dev, and on Vercel (or with --vercel) the full
Build Output including the queue-consumer function VQS discovers.
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

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Auto-detect the Vercel app entry module. Prefers a `_vercel/` entry so it
 * doesn't collide with Vercel's automatic `api/` function detection.
 */
function detectEntryPoint(): string | null {
  const candidates = [
    '_vercel/entry.js',
    '_vercel/entry.mjs',
    '_vercel/entry.ts',
    'api/index.js',
    'api/index.ts',
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(process.cwd(), candidate))) {
      return candidate;
    }
  }
  return null;
}

async function handleBuild(args: string[]): Promise<void> {
  const moduleType = parseModuleType(args);
  const dirs = parseArg(args, '--dirs')?.split(',') ?? ['src'];
  const outDir = parseArg(args, '--out-dir');
  const onVercel = args.includes('--vercel') || Boolean(process.env.VERCEL);

  if (onVercel) {
    const { NestVercelBuilder } = await import('./vercel-builder.js');
    const entryPoint = parseArg(args, '--entry') ?? detectEntryPoint();
    if (!entryPoint) {
      console.error(
        '[@workflow/nest] Could not find a Vercel app entry point.\n' +
          'Create a _vercel/entry.js that default-exports a Node request ' +
          'handler, or pass --entry <path>.'
      );
      process.exit(1);
    }
    if (!existsSync(resolve(process.cwd(), entryPoint))) {
      console.error(`[@workflow/nest] Entry point not found: ${entryPoint}`);
      process.exit(1);
    }
    console.log(
      `[@workflow/nest] Building Vercel output (entry: ${entryPoint}, dirs: ${dirs.join(', ')})`
    );
    const builder = new NestVercelBuilder({
      workingDir: process.cwd(),
      dirs,
      entryPoint,
    });
    await builder.build();
    console.log(
      '[@workflow/nest] Wrote .vercel/output with workflow consumer + app function'
    );
    return;
  }

  // Local dev: build the bundles the WorkflowController serves in-process.
  const { NestLocalBuilder } = await import('./builder.js');
  const builder = new NestLocalBuilder({
    workingDir: process.cwd(),
    dirs,
    moduleType,
    ...(outDir ? { outDir } : {}),
  });
  await builder.build();
  console.log('[@workflow/nest] Built local workflow bundles');
}

/**
 * Main CLI entry point.
 */
async function main() {
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

  if (command === 'build') {
    await handleBuild(args.slice(1));
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run with --help for usage information.');
  process.exit(1);
}

main().catch((error) => {
  console.error('[@workflow/nest]', error);
  process.exit(1);
});
