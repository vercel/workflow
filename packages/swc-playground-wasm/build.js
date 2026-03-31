import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function ensureRustup() {
  if (commandExists('rustup')) return;

  // rustup is not available — the system may have a non-rustup Rust install
  // (e.g. Vercel build environment). Install rustup so we can manage targets.
  if (process.env.CI) {
    console.log('Installing Rust via rustup...');
    if (process.platform === 'win32') {
      runCommand(
        'powershell -Command "iwr https://win.rustup.rs -OutFile rustup-init.exe; .\\rustup-init.exe -y --profile minimal; del rustup-init.exe"'
      );
    } else {
      runCommand(
        'curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal'
      );
    }
    // Add rustup's cargo to PATH so it takes precedence over any system Rust
    const cargoPath = `${process.env.HOME}/.cargo/bin`;
    process.env.PATH = `${cargoPath}:${process.env.PATH}`;
    console.log('Rust installed and PATH updated');
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

console.log('Building swc-playground-wasm...');

ensureRustup();

ensureRustTarget('wasm32-unknown-unknown');

// Check if wasm-pack is installed
if (!commandExists('wasm-pack')) {
  console.log('Installing wasm-pack...');
  runCommand('cargo install wasm-pack');
}

// Build with wasm-pack targeting web (browser ESM)
console.log('Running wasm-pack build...');
const pkgDir = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
runCommand(`wasm-pack build --target web --out-dir pkg --release ${pkgDir}`, {
  cwd: workspaceRoot,
});

// Verify output exists
const wasmFile = new URL('pkg/swc_playground_wasm_bg.wasm', import.meta.url);
if (!existsSync(wasmFile)) {
  console.error('Build failed: WASM file not found in pkg/');
  process.exit(1);
}

console.log('Build complete!');
