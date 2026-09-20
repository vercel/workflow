#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModuleType as parseModuleTypeRaw } from './parse-module-type.js';
import { hasWorkflowPlugin, mergeSwcrc, serializeSwcrc } from './swcrc.js';

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
  --force          Rewrite the workflow settings in an existing .swcrc

Build options:
  --vercel               Emit a Vercel Build Output API directory
                         (.vercel/output) with the workflow queue-consumer
                         function so runs are dispatched on Vercel. Implied
                         when the VERCEL env var is set.
  --dirs <dirs>          Comma-separated workflow source dirs (default: 'src')
  --entry <path>         Vercel app entry module that default-exports a Node
                         request handler (default: auto-detected)
  --out-dir <dir>        Output dir for local dev bundles
                         (default: '.nestjs/workflow')
  --module <type>        SWC module type: 'es6' (default) or 'commonjs'
  --base-path <path>     Route prefix the app is served under. Must match
                         app.setGlobalPrefix() and WorkflowModule's basePath.
  --sourcemap <mode>     esbuild sourcemap mode: true, false, inline, linked,
                         external, both
  --max-duration <secs>  maxDuration for the app function (Vercel, default 300)
  --runtime <runtime>    Vercel runtime for the emitted functions,
                         e.g. nodejs22.x
  --app-function <name>  Name of the catch-all app function (default: __nest)

'init' writes the .swcrc settings the Workflow SWC plugin needs, preserving any
other configuration already in the file. 'build' generates the workflow bundles
for local dev, and on Vercel (or with --vercel) the full Build Output including
the queue-consumer function VQS discovers.
`);
}

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

  const existingContent = existsSync(swcrcPath)
    ? readFileSync(swcrcPath, 'utf-8')
    : undefined;

  if (existingContent !== undefined && !forceMode) {
    if (hasWorkflowPlugin(existingContent)) {
      console.log('✓ .swcrc already configured with workflow plugin');
      console.log('  Run with --force to refresh the resolved plugin path');
      process.exit(0);
    }
    console.log(
      '⚠ .swcrc already exists without the workflow plugin. Run with --force ' +
        'to add it; your other settings are preserved.'
    );
    process.exit(1);
  }

  const pluginPath = resolveSwcPluginPath();
  const { config, merged } = mergeSwcrc(
    existingContent,
    pluginPath,
    moduleType
  );

  writeFileSync(swcrcPath, serializeSwcrc(config));
  if (merged) {
    console.log('✓ Updated .swcrc with workflow plugin configuration');
    console.log('  Existing SWC settings were preserved');
  } else {
    console.log('✓ Created .swcrc with workflow plugin configuration');
  }
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

function parseNumberArg(args: string[], flag: string): number | undefined {
  const raw = parseArg(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid ${flag}: ${raw}. Must be a positive number.`);
    process.exit(1);
  }
  return value;
}

const SOURCEMAP_MODES = [
  'true',
  'false',
  'inline',
  'linked',
  'external',
  'both',
] as const;

function parseSourcemapArg(
  args: string[]
): boolean | 'inline' | 'linked' | 'external' | 'both' | undefined {
  const raw = parseArg(args, '--sourcemap');
  if (raw === undefined) return undefined;
  if (!(SOURCEMAP_MODES as readonly string[]).includes(raw)) {
    console.error(
      `Invalid --sourcemap: ${raw}. Must be one of ${SOURCEMAP_MODES.join(', ')}.`
    );
    process.exit(1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw as 'inline' | 'linked' | 'external' | 'both';
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

type BuildFlags = {
  dirs: string[];
  moduleType: 'es6' | 'commonjs';
  outDir?: string;
  basePath?: string;
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
  runtime?: string;
  maxDuration?: number;
  appFunctionName?: string;
};

function parseBuildFlags(args: string[]): BuildFlags {
  return {
    moduleType: parseModuleType(args),
    dirs: parseArg(args, '--dirs')?.split(',') ?? ['src'],
    outDir: parseArg(args, '--out-dir'),
    basePath: parseArg(args, '--base-path'),
    sourcemap: parseSourcemapArg(args),
    runtime: parseArg(args, '--runtime'),
    maxDuration: parseNumberArg(args, '--max-duration'),
    appFunctionName: parseArg(args, '--app-function'),
  };
}

/** Drop keys whose value is undefined so they do not override a default. */
function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

function resolveVercelEntryPoint(args: string[]): string {
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
  return entryPoint;
}

async function buildVercelOutput(
  args: string[],
  flags: BuildFlags
): Promise<void> {
  const { NestVercelBuilder } = await import('./vercel-builder.js');
  const entryPoint = resolveVercelEntryPoint(args);
  console.log(
    `[@workflow/nest] Building Vercel output (entry: ${entryPoint}, dirs: ${flags.dirs.join(', ')})`
  );
  const builder = new NestVercelBuilder({
    workingDir: process.cwd(),
    dirs: flags.dirs,
    entryPoint,
    ...defined({
      basePath: flags.basePath,
      sourcemap: flags.sourcemap,
      runtime: flags.runtime,
      maxDuration: flags.maxDuration,
      appFunctionName: flags.appFunctionName,
    }),
  });
  await builder.build();
  console.log(
    '[@workflow/nest] Wrote .vercel/output with workflow consumer + app function'
  );
}

async function buildLocalBundles(flags: BuildFlags): Promise<void> {
  // The bundles the WorkflowController serves in-process.
  const { NestLocalBuilder } = await import('./builder.js');
  const builder = new NestLocalBuilder({
    workingDir: process.cwd(),
    dirs: flags.dirs,
    moduleType: flags.moduleType,
    ...defined({
      outDir: flags.outDir,
      basePath: flags.basePath,
      sourcemap: flags.sourcemap,
    }),
  });
  await builder.build();
  console.log('[@workflow/nest] Built local workflow bundles');
}

async function handleBuild(args: string[]): Promise<void> {
  const flags = parseBuildFlags(args);
  const onVercel = args.includes('--vercel') || Boolean(process.env.VERCEL);
  if (onVercel) {
    await buildVercelOutput(args, flags);
    return;
  }
  await buildLocalBundles(flags);
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
