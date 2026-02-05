#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestLocalBuilder } from './builder.js';

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
 * @deprecated Use `npx @workflow/nest build` instead
 */
function generateSwcrc(pluginPath: string): object {
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
      type: 'es6',
    },
    sourceMaps: true,
  };
}

function showHelp(): void {
  console.log(`
@workflow/nest CLI

Commands:
  build     Build workflow bundles (recommended)
  dev       Build and watch for changes
  init      Generate .swcrc configuration (deprecated)
  help      Show this help message

Usage:
  npx @workflow/nest build          # Build workflow bundles
  npx @workflow/nest dev            # Build and watch for changes
  npx @workflow/nest init           # (Deprecated) Generate .swcrc

Options:
  --dirs <dirs>     Directories to scan (comma-separated, default: src)
  --out <dir>       Output directory (default: .workflow)
  --force           Force overwrite existing files

The build command creates workflow bundles and client exports that work
with any NestJS compiler (tsc, swc, or babel). No .swcrc configuration needed.
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

function handleInit(args: string[]): void {
  console.log(
    '⚠️  The init command is deprecated. Use `npx @workflow/nest build` instead.'
  );
  console.log(
    '   This provides a simpler setup that works with any compiler.\n'
  );

  const swcrcPath = resolve(process.cwd(), '.swcrc');
  const forceMode = args.includes('--force');

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
  const swcrc = generateSwcrc(pluginPath);

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

function parseArgs(args: string[]): {
  dirs: string[];
  outDir: string;
  force: boolean;
} {
  const dirs: string[] = [];
  let outDir = '.workflow';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dirs' && args[i + 1]) {
      dirs.push(...args[++i].split(',').map((d) => d.trim()));
    } else if (arg === '--out' && args[i + 1]) {
      outDir = args[++i];
    } else if (arg === '--force') {
      force = true;
    }
  }

  return {
    dirs: dirs.length > 0 ? dirs : ['src'],
    outDir,
    force,
  };
}

async function handleBuild(args: string[]): Promise<void> {
  const { dirs, outDir } = parseArgs(args);
  const workingDir = process.cwd();
  const fullOutDir = resolve(workingDir, outDir);

  console.log(`Building workflows from: ${dirs.join(', ')}`);
  console.log(`Output directory: ${outDir}\n`);

  const builder = new NestLocalBuilder({
    workingDir,
    dirs,
    outDir: fullOutDir,
    watch: false,
  });

  await builder.build();
  console.log('\n✓ Build complete');
}

async function handleDev(args: string[]): Promise<void> {
  const { dirs, outDir } = parseArgs(args);
  const workingDir = process.cwd();
  const fullOutDir = resolve(workingDir, outDir);

  console.log(`Watching workflows in: ${dirs.join(', ')}`);
  console.log(`Output directory: ${outDir}\n`);

  const builder = new NestLocalBuilder({
    workingDir,
    dirs,
    outDir: fullOutDir,
    watch: true,
  });

  // Initial build
  await builder.build();
  console.log('\n✓ Initial build complete');
  console.log('Watching for changes... (press Ctrl+C to stop)\n');

  // Watch for changes
  const watchDirs = dirs.map((d) => resolve(workingDir, d));
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const dir of watchDirs) {
    if (!existsSync(dir)) {
      console.error(`Error: Directory does not exist: ${dir}`);
      console.error('Please create the directory or specify a different path with --dirs');
      process.exit(1);
    }
    watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith('.ts') && !filename?.endsWith('.js')) return;

      // Debounce rebuilds
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`\nFile changed: ${filename}`);
        try {
          await builder.build();
          console.log('✓ Rebuild complete');
        } catch (error) {
          console.error(
            'Build failed:',
            error instanceof Error ? error.message : error
          );
        }
      }, 100);
    });
  }

  // Keep process running
  await new Promise(() => {});
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
    handleInit(args.slice(1));
    process.exit(0);
  }

  if (command === 'build') {
    await handleBuild(args.slice(1));
    process.exit(0);
  }

  if (command === 'dev') {
    await handleDev(args.slice(1));
    // dev mode keeps running
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run with --help for usage information.');
  process.exit(1);
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
