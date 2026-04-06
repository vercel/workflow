import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function runCommand(command) {
  try {
    execSync(command, { stdio: 'inherit', shell: true });
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

console.log('Building swc-playground-wasm...');

ensureRustup();

// Check if wasm32-unknown-unknown target exists and install if needed
console.log('Checking wasm32-unknown-unknown target...');
try {
  const installedTargets = execSync('rustup target list --installed', {
    stdio: 'pipe',
    shell: true,
  }).toString();
  if (!installedTargets.includes('wasm32-unknown-unknown')) {
    console.log('wasm32-unknown-unknown target not found, installing...');
    runCommand('rustup target add wasm32-unknown-unknown');
  } else {
    console.log('wasm32-unknown-unknown target already installed');
  }
} catch (error) {
  console.error(
    'Failed to check/install wasm32-unknown-unknown target:',
    error.message
  );
  process.exit(1);
}

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
