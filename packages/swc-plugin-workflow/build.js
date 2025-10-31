import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { env, exit, platform } = process;
const shell = platform === 'win32';
const __dirname = dirname(fileURLToPath(import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }

  return result;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
    shell,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }

  return result.stdout || '';
}

function commandExists(command) {
  const which = shell ? 'where' : 'which';
  const check = spawnSync(which, [command], {
    stdio: 'ignore',
    shell,
  });

  return check.status === 0;
}

function main() {
  if (!commandExists('cargo')) {
    console.error('Rust (cargo) is required but not installed.');
    console.error(
      'Please visit https://rustup.rs and follow the installation instructions.'
    );
    console.error(
      "After installing, run 'rustup target add wasm32-unknown-unknown'."
    );
    exit(1);
  }

  if (!commandExists('rustup')) {
    console.error(
      'rustup was not found in PATH. It is required to manage the wasm32 target.'
    );
    console.error(
      'Please install rustup from https://rustup.rs and ensure it is in PATH.'
    );
    exit(1);
  }

  const installedTargets = runCapture('rustup', [
    'target',
    'list',
    '--installed',
  ]);

  if (!installedTargets.includes('wasm32-unknown-unknown')) {
    if (env.CI) {
      run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
    } else {
      console.error('The wasm32-unknown-unknown target is not installed.');
      console.error(
        "Please run 'rustup target add wasm32-unknown-unknown' to install it."
      );
      exit(1);
    }
  }

  run('cargo', [
    'build',
    '--release',
    '-p',
    'swc_plugin_workflow',
    '--target',
    'wasm32-unknown-unknown',
  ]);

  const source = join(
    __dirname,
    '../../target/wasm32-unknown-unknown/release/swc_plugin_workflow.wasm'
  );
  const destination = join(__dirname, 'swc_plugin_workflow.wasm');

  if (!existsSync(source)) {
    console.error(`Built wasm file not found at ${source}`);
    exit(1);
  }

  copyFileSync(source, destination);
  console.log(`Copied ${source} -> ${destination}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exit(1);
}
