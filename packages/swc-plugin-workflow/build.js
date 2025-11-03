import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

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

// Build the WASM plugin
console.log('Running cargo build...');
runCommand(
  'cargo build --target wasm32-unknown-unknown --release -p swc_workflow'
);

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
  process.exit(1);
}

console.log('Copying WASM file...');
copyFileSync(wasmSource, wasmDest);

console.log('Build complete!');
