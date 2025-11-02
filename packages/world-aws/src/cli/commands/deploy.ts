import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface DeployOptions {
  stackName?: string;
  region?: string;
  skipBuild?: boolean;
}

export async function deploy(options: DeployOptions = {}) {
  const cwd = process.cwd();
  const infraDir = join(cwd, 'infrastructure');

  console.log('\n🚀 Deploying AWS Workflow\n');

  // Verify infrastructure exists
  if (!existsSync(infraDir)) {
    console.error('❌ Error: infrastructure/ directory not found');
    console.log('   Run: aws-workflow init');
    process.exit(1);
  }

  try {
    // Step 1: Build Next.js (unless skipped)
    if (!options.skipBuild) {
      await runCommand({
        message: '📦 Building Next.js app...',
        command: 'npm',
        args: ['run', 'build'],
        cwd,
      });
    } else {
      console.log('⏭️  Skipping Next.js build...');
    }

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
      message: '🔨 Building infrastructure...',
      command: 'npm',
      args: ['run', 'build'],
      cwd: infraDir,
    });

    // Step 4: CDK synth
    await runCommand({
      message: '🔍 Synthesizing CDK stack...',
      command: 'npx',
      args: ['cdk', 'synth', '--quiet'],
      cwd: infraDir,
    });

    // Step 5: CDK deploy
    const deployArgs = ['cdk', 'deploy', '--require-approval', 'never'];
    if (options.stackName) {
      deployArgs.push(options.stackName);
    }

    await runCommand({
      message: '☁️  Deploying to AWS...',
      command: 'npx',
      args: deployArgs,
      cwd: infraDir,
      showOutput: true,
    });

    // Step 6: Extract outputs and update .env.local
    console.log('💾 Updating .env.local with deployment outputs...');
    await updateEnvFromOutputs(
      cwd,
      infraDir,
      options.stackName || 'workflow-dev'
    );

    console.log('\n✅ Deployment complete!\n');
    console.log('🎉 Your workflow infrastructure is ready');
    console.log('📝 Updated .env.local with AWS configuration\n');
    console.log('Next steps:');
    console.log('  - Start your Next.js app: npm run dev');
    console.log('  - Test a workflow by calling your API route\n');
  } catch (error) {
    console.error('\n❌ Deployment failed');
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

async function updateEnvFromOutputs(
  cwd: string,
  infraDir: string,
  stackName: string
): Promise<void> {
  try {
    // Get CDK outputs
    const outputsCmd = spawn('npx', ['cdk', 'outputs', '--json', stackName], {
      cwd: infraDir,
      stdio: 'pipe',
      shell: true,
    });

    let outputData = '';
    outputsCmd.stdout.on('data', (data) => {
      outputData += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      outputsCmd.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Failed to get CDK outputs'));
      });
    });

    const outputs = JSON.parse(outputData);
    const stackOutputs = outputs[stackName] || {};

    // Read existing .env.local
    const envPath = join(cwd, '.env.local');
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

    // Update or add each output
    const outputMappings: Record<string, string> = {
      RunsTableName: 'WORKFLOW_AWS_RUNS_TABLE',
      StepsTableName: 'WORKFLOW_AWS_STEPS_TABLE',
      EventsTableName: 'WORKFLOW_AWS_EVENTS_TABLE',
      HooksTableName: 'WORKFLOW_AWS_HOOKS_TABLE',
      StreamsTableName: 'WORKFLOW_AWS_STREAMS_TABLE',
      WorkflowQueueUrl: 'WORKFLOW_AWS_WORKFLOW_QUEUE_URL',
      StepQueueUrl: 'WORKFLOW_AWS_STEP_QUEUE_URL',
      StreamBucketName: 'WORKFLOW_AWS_STREAM_BUCKET',
    };

    for (const [outputKey, envKey] of Object.entries(outputMappings)) {
      const value = stackOutputs[outputKey];
      if (value) {
        const regex = new RegExp(`^${envKey}=.*$`, 'm');
        if (regex.test(envContent)) {
          // Update existing
          envContent = envContent.replace(regex, `${envKey}=${value}`);
        } else {
          // Add new
          envContent += `\n${envKey}=${value}`;
        }
      }
    }

    writeFileSync(envPath, envContent.trim() + '\n');
    console.log('   ✓ Updated .env.local');
  } catch (error) {
    console.warn('   ⚠️  Could not auto-update .env.local');
    console.warn('   You may need to manually copy values from CDK outputs');
  }
}
