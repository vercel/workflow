import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function execCommand(command, options = {}) {
  return execSync(command, { stdio: 'inherit', shell: true, ...options });
}

function runCommand(command, options = {}) {
  try {
    execCommand(command, options);
  } catch (error) {
    console.error(`Command failed: ${command}: ${error}`);
    process.exit(1);
  }
}

function commandExists(command) {
  try {
    execSync(`${command} --version`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRustTargetInstalled(target) {
  const installedTargets = execSync('rustup target list --installed', {
    stdio: 'pipe',
    shell: true,
  }).toString();
  return installedTargets.includes(target);
}

function withTargetInstallLock(target, callback) {
  const lockDir = path.join(
    tmpdir(),
    `workflow-rustup-target-${target.replaceAll(/[^a-z0-9_-]/gi, '-')}.lock`
  );
  const timeoutMs = 2 * 60 * 1000;
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Timed out waiting for rustup target install lock for ${target}`
        );
      }

      console.log(
        `Another process is installing ${target}; waiting for the lock...`
      );
      sleepMs(1000);
    }
  }

  try {
    return callback();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function ensureRustTarget(target) {
  console.log(`Checking ${target} target...`);

  try {
    if (isRustTargetInstalled(target)) {
      console.log(`${target} target already installed`);
      return;
    }

    withTargetInstallLock(target, () => {
      if (isRustTargetInstalled(target)) {
        console.log(`${target} target was installed by another process`);
        return;
      }

      console.log(`${target} target not found, installing...`);
      try {
        execCommand(`rustup target add ${target}`);
      } catch (error) {
        if (isRustTargetInstalled(target)) {
          console.warn(
            `${target} target appears installed after a rustup error; continuing`
          );
          return;
        }
        throw error;
      }
    });
  } catch (error) {
    console.error(`Failed to check/install ${target} target:`, error.message);
    process.exit(1);
  }
}

console.log('Building swc-plugin-workflow WASM...');

// Check if cargo is installed
if (!commandExists('cargo')) {
  if (process.env.CI) {
    console.log('Installing Rust...');
    if (process.platform === 'win32') {
      runCommand(
        'powershell -Command "iwr https://win.rustup.rs -OutFile rustup-init.exe; .\\rustup-init.exe -y --profile minimal; del rustup-init.exe"'
      );
    } else {
      runCommand(
        'curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal'
      );
      // Add Rust to PATH for this process so cargo commands work
      const cargoPath = `${process.env.HOME}/.cargo/bin`;
      process.env.PATH = `${cargoPath}:${process.env.PATH}`;
      console.log('Rust installed and PATH updated');
    }
  } else {
    console.error('Rust is required but not installed.');
    console.error(
      'Please visit https://rustup.rs and follow the installation instructions.'
    );
    console.error(
      'After installing, run "rustup target add wasm32-unknown-unknown"'
    );
    process.exit(1);
  }
}

ensureRustTarget('wasm32-unknown-unknown');

// Build the WASM plugin
console.log('Running cargo build...');
runCommand('cargo build-wasm32 --release -p swc_plugin_workflow');

// Copy the WASM file
const wasmSource = new URL(
  '../../target/wasm32-unknown-unknown/release/swc_plugin_workflow.wasm',
  import.meta.url
);
const wasmDest = new URL('swc_plugin_workflow.wasm', import.meta.url);
console.log(`Source: ${wasmSource}`);
console.log(`Destination: ${wasmDest}`);

if (!existsSync(wasmSource)) {
  console.error(`WASM file not found at ${wasmSource}`);
  console.error(
    'The cargo build may have failed or produced output at a different location.'
  );

  // TODO: Remove this once we verify what's going on in CI
  try {
    const targetDir = new URL('../../target', import.meta.url);
    console.error('\nDebug: Listing target directory contents...');
    const files = readdirSync(targetDir, { recursive: true });
    const wasmFiles = files.filter(
      (f) => typeof f === 'string' && f.endsWith('.wasm')
    );
    console.error(
      `Found ${files.length} total files, ${wasmFiles.length} WASM-related`
    );
    if (wasmFiles.length > 0) {
      console.error('WASM files:', wasmFiles.slice(0, 10));
    } else {
      console.error('Sample files in target:', files.slice(0, 20));
    }
  } catch (err) {
    console.error('Debug: Cannot read target directory:', err.message);
  }

  process.exit(1);
}

console.log('Copying WASM file...');
copyFileSync(wasmSource, wasmDest);

// Generate hash of the WASM file for cache invalidation
console.log('Generating build hash...');
const wasmContent = readFileSync(wasmDest);
const buildHash = createHash('sha256')
  .update(wasmContent)
  .digest('hex')
  .slice(0, 16);
const buildHashPath = new URL('build-hash.json', import.meta.url);
writeFileSync(buildHashPath, JSON.stringify({ buildHash }, null, 2));
console.log(`Build hash: ${buildHash}`);

console.log('Build complete!');
