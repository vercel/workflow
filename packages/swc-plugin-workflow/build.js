import { execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

function runCommand(command) {
  try {
    execSync(command, { stdio: 'inherit', shell: true });
  } catch (error) {
    console.error(`Command failed: ${command}`);
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
        'curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal && . $HOME/.cargo/env'
      );
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

// Check if wasm32-unknown-unknown target exists
try {
  execSync('rustup target list --installed', { stdio: 'pipe', shell: true })
    .toString()
    .includes('wasm32-unknown-unknown');
} catch {
  if (process.env.CI) {
    console.log('Installing wasm32-unknown-unknown target...');
    runCommand('rustup target add wasm32-unknown-unknown');
  } else {
    console.error('The wasm32-unknown-unknown target is not installed.');
    console.error(
      'Please run "rustup target add wasm32-unknown-unknown" to install it.'
    );
    process.exit(1);
  }
}

// Build the WASM plugin
console.log('Running cargo build...');
runCommand(
  'cargo build --target wasm32-unknown-unknown --release -p swc_workflow'
);

// Copy the WASM file
const wasmSource = join(
  '../../target/wasm32-unknown-unknown/release/swc_plugin_workflow.wasm'
);
const wasmDest = 'swc_plugin_workflow.wasm';
console.log(`Copying ${wasmSource} to ${wasmDest}...`);
copyFileSync(wasmSource, wasmDest);

console.log('Build complete!');
