import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

interface DestroyOptions {
  stackName?: string;
  force?: boolean;
}

export async function destroy(options: DestroyOptions = {}) {
  const cwd = process.cwd();
  const infraDir = join(cwd, 'infrastructure');
  const stackName = options.stackName || 'workflow-dev';

  console.log('\n⚠️  Destroying AWS Workflow Infrastructure\n');
  console.log(`Stack: ${stackName}\n`);

  // Verify infrastructure exists
  if (!existsSync(infraDir)) {
    console.error('❌ Error: infrastructure/ directory not found');
    console.log('   Nothing to destroy');
    process.exit(1);
  }

  try {
    // Step 1: Confirm with user (unless --force)
    if (!options.force) {
      const confirmed = await confirm(
        'This will permanently delete all AWS resources. Continue? (y/N): '
      );

      if (!confirmed) {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    // Step 2: Run CDK destroy
    console.log('🗑️  Destroying AWS resources...\n');

    await runCommand({
      message: 'Running CDK destroy...',
      command: 'npx',
      args: ['cdk', 'destroy', stackName, '--force'],
      cwd: infraDir,
      showOutput: true,
    });

    // Step 3: Clean up .env.local (remove AWS values)
    console.log('\n🧹 Cleaning up .env.local...');
    cleanEnvLocal(cwd);

    console.log('\n✅ Destroy complete!\n');
    console.log('All AWS resources have been removed.');
    console.log(
      'Note: Some resources like S3 buckets may require manual deletion if they contain data.\n'
    );
  } catch (error) {
    console.error('\n❌ Destroy failed');
    console.error(error);
    process.exit(1);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

interface RunCommandOptions {
  message: string;
  command: string;
  args: string[];
  cwd: string;
  showOutput?: boolean;
}

async function runCommand(options: RunCommandOptions): Promise<void> {
  if (!options.showOutput) {
    console.log(options.message);
  }

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
        if (!options.showOutput) {
          console.log(`   ✓ Complete\n`);
        }
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

function cleanEnvLocal(cwd: string): void {
  const envPath = join(cwd, '.env.local');

  if (!existsSync(envPath)) {
    return;
  }

  try {
    let content = readFileSync(envPath, 'utf-8');

    // Remove AWS-specific values (but keep the keys as comments)
    const awsKeys = [
      'WORKFLOW_AWS_RUNS_TABLE',
      'WORKFLOW_AWS_STEPS_TABLE',
      'WORKFLOW_AWS_EVENTS_TABLE',
      'WORKFLOW_AWS_HOOKS_TABLE',
      'WORKFLOW_AWS_STREAMS_TABLE',
      'WORKFLOW_AWS_WORKFLOW_QUEUE_URL',
      'WORKFLOW_AWS_STEP_QUEUE_URL',
      'WORKFLOW_AWS_STREAM_BUCKET',
    ];

    for (const key of awsKeys) {
      const regex = new RegExp(`^${key}=.*$`, 'gm');
      content = content.replace(regex, `# ${key}=`);
    }

    writeFileSync(envPath, content);
    console.log('   ✓ Cleaned .env.local');
  } catch (error) {
    console.warn('   ⚠️  Could not clean .env.local');
  }
}
