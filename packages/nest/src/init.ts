import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describeSwcBuilderProblems,
  detectPackageManager,
  inspectSwcBuilderPackages,
} from './swc-builder-deps.js';
import { hasWorkflowPlugin, mergeSwcrc, serializeSwcrc } from './swcrc.js';

export interface InitOptions {
  workingDir: string;
  moduleType: 'es6' | 'commonjs';
  force: boolean;
  /** Absolute path of the Workflow SWC plugin to write into `.swcrc`. */
  pluginPath: () => string;
  log?: (message: string) => void;
}

/**
 * Warn about SWC builder packages that would make `nest build` fail. Never
 * throws: a broken check must not stop `init` (which runs as `prebuild`).
 */
function warnAboutSwcBuilderPackages(
  workingDir: string,
  log: (message: string) => void
): void {
  let problems: string | null;
  try {
    problems = describeSwcBuilderProblems(
      inspectSwcBuilderPackages(workingDir),
      detectPackageManager(workingDir, process.env.npm_config_user_agent)
    );
  } catch {
    return;
  }
  if (problems) log(`\n${problems}`);
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

  if (existingContent !== undefined && !force) {
    if (hasWorkflowPlugin(existingContent)) {
      log('✓ .swcrc already configured with workflow plugin');
      log('  Run with --force to refresh the resolved plugin path');
      warnAboutSwcBuilderPackages(workingDir, log);
      return 0;
    }
    log(
      '⚠ .swcrc already exists without the workflow plugin. Run with --force ' +
        'to add it; your other settings are preserved.'
    );
    warnAboutSwcBuilderPackages(workingDir, log);
    return 1;
  }

  const pluginPath = options.pluginPath();
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

  warnAboutSwcBuilderPackages(workingDir, log);

  log('\nNext steps:');
  log('1. Ensure nest-cli.json has: "compilerOptions": { "builder": "swc" }');
  log('2. Add .swcrc to .gitignore (it contains absolute paths)');
  log('3. Run: nest build');
  return 0;
}
