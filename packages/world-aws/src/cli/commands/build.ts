import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export async function build() {
  const cwd = process.cwd();
  const infraDir = join(cwd, 'infrastructure');

  console.log('\n🔨 Building workflow infrastructure...\n');

  // Verify infrastructure exists
  if (!existsSync(infraDir)) {
    console.error('❌ Error: infrastructure/ directory not found');
    console.log('   Run: aws-workflow init');
    process.exit(1);
  }

  try {
    // Step 1: Build Next.js (generates workflow bundles)
    await runCommand({
      message: '📦 Building Next.js app...',
      command: 'npm',
      args: ['run', 'build'],
      cwd,
    });

    // Step 2: Install/update infrastructure dependencies
    if (existsSync(join(infraDir, 'package.json'))) {
      await runCommand({
        message: '📥 Installing infrastructure dependencies...',
        command: 'npm',
        args: ['install'],
        cwd: infraDir,
      });
    }

    // Step 3: Build infrastructure
    await runCommand({
      message: '🔨 Building infrastructure code...',
      command: 'npm',
      args: ['run', 'build'],
      cwd: infraDir,
    });

    // Step 4: CDK synth (validates the stack without deploying)
    await runCommand({
      message: '🔍 Synthesizing CDK stack...',
      command: 'npx',
      args: ['cdk', 'synth', '--quiet'],
      cwd: infraDir,
    });

    console.log('\n✅ Build complete!\n');
    console.log('Your infrastructure is ready to deploy.');
    console.log('Run: npm run deploy\n');
  } catch (error) {
    console.error('\n❌ Build failed');
    console.error(error);
    process.exit(1);
  }
}

interface RunCommandOptions {
  message: string;
  command: string;
  args: string[];
  cwd: string;
  showOutput?: boolean;
}

async function runCommand(options: RunCommandOptions): Promise<void> {
  console.log(options.message);

  return new Promise((resolve, reject) => {
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: options.showOutput ? 'inherit' : 'pipe',
      shell: true,
    });

    let output = '';
    if (!options.showOutput) {
      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`   ✓ Complete\n`);
        resolve();
      } else {
        if (output && !options.showOutput) {
          console.error(output);
        }
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}
