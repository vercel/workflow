import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function runCommand(command, options = {}) {
  try {
    execSync(command, { stdio: 'inherit', shell: true, ...options });
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

console.log('Building swc-playground-wasm...');

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
      const cargoPath = `${process.env.HOME}/.cargo/bin`;
      process.env.PATH = `${cargoPath}:${process.env.PATH}`;
      console.log('Rust installed and PATH updated');
    }
  } else {
    console.error('Rust is required but not installed.');
    console.error(
      'Please visit https://rustup.rs and follow the installation instructions.'
    );
    process.exit(1);
  }
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
