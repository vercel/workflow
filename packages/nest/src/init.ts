import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SWC_PLUGIN_BUILD,
  describeSwcBuilderProblems,
  detectPackageManager,
  inspectSwcBuilderPackages,
  type SwcBuilderStatus,
  type SwcPluginBuild,
  swcPluginBuildFor,
  swcPluginBuildOfPath,
} from './swc-builder-deps.js';
import {
  hasWorkflowPlugin,
  mergeSwcrc,
  serializeSwcrc,
  workflowPluginPath,
} from './swcrc.js';

export interface InitOptions {
  workingDir: string;
  moduleType: 'es6' | 'commonjs';
  force: boolean;
  /**
   * Absolute path of the Workflow SWC plugin build to write into `.swcrc`,
   * given the `@workflow/swc-plugin` export for it (one per `@swc/core` line).
   */
  pluginPath: (specifier: string) => string;
  log?: (message: string) => void;
}

/**
 * The SWC packages `nest build` will use, or `null` when they can't be
 * inspected. Never throws: a broken check must not stop `init` (which runs as
 * `prebuild`).
 */
function inspectSafely(workingDir: string): SwcBuilderStatus | null {
  try {
    return inspectSwcBuilderPackages(workingDir);
  } catch {
    return null;
  }
}

/**
 * The plugin build that runs on the `@swc/core` `nest build` will load: the
 * 1.15 build (the package's main export) when it's missing, unsupported or
 * couldn't be inspected, since that is what `init` wrote before there were two.
 */
function pluginBuildFor(status: SwcBuilderStatus | null): SwcPluginBuild {
  if (status?.core.state !== 'supported') return DEFAULT_SWC_PLUGIN_BUILD;
  return swcPluginBuildFor(status.core.version) ?? DEFAULT_SWC_PLUGIN_BUILD;
}

/** Warn about SWC builder packages that would make `nest build` fail. */
function warnAboutSwcBuilderPackages(
  workingDir: string,
  status: SwcBuilderStatus | null,
  log: (message: string) => void
): void {
  if (!status) return;
  let problems: string | null;
  try {
    problems = describeSwcBuilderProblems(
      status,
      detectPackageManager(workingDir, process.env.npm_config_user_agent)
    );
  } catch {
    return;
  }
  if (problems) log(`\n${problems}`);
}

/**
 * Warn when an existing `.swcrc` points at the plugin build for another
 * `@swc/core` line than the one installed, say after an upgrade from 1.15 to
 * 1.16: `nest build` would fail to invoke it.
 */
function warnAboutPluginBuildMismatch(
  swcrcContent: string,
  status: SwcBuilderStatus | null,
  log: (message: string) => void
): void {
  if (status?.core.state !== 'supported') return;
  const configured = workflowPluginPath(swcrcContent);
  const configuredBuild = configured && swcPluginBuildOfPath(configured);
  const needed = swcPluginBuildFor(status.core.version);
  if (!configuredBuild || !needed || configuredBuild === needed) return;
  log(
    `\n⚠ .swcrc points at the Workflow SWC plugin built for @swc/core ` +
      `${configuredBuild.line}.x, but @swc/core ${status.core.version} is ` +
      'installed, so `nest build` fails with "failed to invoke plugin".\n' +
      '  Fix it with: npx @workflow/nest init --force'
  );
}

/**
 * `workflow-nest init`: write the `.swcrc` settings the Workflow SWC plugin
 * needs and check the SWC packages `nest build` will use. Returns the exit
 * code.
 */
export function runInit(options: InitOptions): number {
  const { workingDir, moduleType, force } = options;
  const log = options.log ?? console.log;
  const swcrcPath = resolve(workingDir, '.swcrc');

  const existingContent = existsSync(swcrcPath)
    ? readFileSync(swcrcPath, 'utf-8')
    : undefined;

  const status = inspectSafely(workingDir);

  if (existingContent !== undefined && !force) {
    if (hasWorkflowPlugin(existingContent)) {
      log('✓ .swcrc already configured with workflow plugin');
      log('  Run with --force to refresh the resolved plugin path');
      warnAboutPluginBuildMismatch(existingContent, status, log);
      warnAboutSwcBuilderPackages(workingDir, status, log);
      return 0;
    }
    log(
      '⚠ .swcrc already exists without the workflow plugin. Run with --force ' +
        'to add it; your other settings are preserved.'
    );
    warnAboutSwcBuilderPackages(workingDir, status, log);
    return 1;
  }

  const pluginPath = options.pluginPath(pluginBuildFor(status).specifier);
  const { config, merged } = mergeSwcrc(
    existingContent,
    pluginPath,
    moduleType
  );

  writeFileSync(swcrcPath, serializeSwcrc(config));
  if (merged) {
    log('✓ Updated .swcrc with workflow plugin configuration');
    log('  Existing SWC settings were preserved');
  } else {
    log('✓ Created .swcrc with workflow plugin configuration');
  }
  log(`  Plugin path: ${pluginPath}`);

  warnAboutSwcBuilderPackages(workingDir, status, log);

  log('\nNext steps:');
  log('1. Ensure nest-cli.json has: "compilerOptions": { "builder": "swc" }');
  log('2. Add .swcrc to .gitignore (it contains absolute paths)');
  log('3. Run: nest build');
  return 0;
}
