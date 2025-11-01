#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

// __dirname is available in CommonJS by default

const commands = {
  bootstrap: {
    description: 'Bootstrap AWS infrastructure (first-time setup)',
    script: 'bootstrap.sh',
  },
  deploy: {
    description: 'Deploy workflow code to Lambda',
    script: 'deploy.sh',
  },
  teardown: {
    description: 'Destroy all AWS resources',
    script: 'teardown.sh',
  },
  outputs: {
    description: 'Display environment variables from deployed stack',
    script: 'outputs.sh',
  },
  logs: {
    description: 'Tail Lambda function logs',
    script: null, // Direct AWS CLI call
  },
};

function showHelp() {
  console.log(`
╔════════════════════════════════════════╗
║  AWS Workflow CLI                      ║
╚════════════════════════════════════════╝

Usage: npx aws-workflow <command>

Commands:
  bootstrap    Bootstrap AWS infrastructure (first-time setup)
  deploy       Deploy workflow code to Lambda
  outputs      Display environment variables from deployed stack
  logs         Tail Lambda function logs in real-time
  teardown     Destroy all AWS resources

Examples:
  npx aws-workflow bootstrap              # Initial setup
  npx aws-workflow deploy                 # Deploy/update workflows
  npx aws-workflow outputs > .env.aws     # Save env vars to file
  npx aws-workflow logs                   # Watch logs
  npx aws-workflow teardown               # Clean up everything

Documentation: https://useworkflow.dev/docs
`);
}

function runCommand(command: string) {
  const cmd = commands[command as keyof typeof commands];

  if (!cmd) {
    console.error(`❌ Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }

  // Special case for logs - direct AWS CLI call
  if (command === 'logs') {
    const region = process.env.AWS_REGION || 'us-east-1';
    const logCommand = `aws logs tail /aws/lambda/workflow-worker --since 5m --region ${region} --follow`;
    console.log(`📋 Tailing Lambda logs (region: ${region})...`);
    console.log('Press Ctrl+C to exit\n');
    try {
      execSync(logCommand, { stdio: 'inherit' });
    } catch (error) {
      // Ctrl+C exits with code 130, which is expected
      if ((error as any).status !== 130) {
        console.error('Failed to tail logs. Make sure AWS CLI is configured.');
        process.exit(1);
      }
    }
    return;
  }

  // Find the script in the package
  // __dirname is dist/bin/, so go up two levels to reach package root
  const packageRoot = join(__dirname, '..', '..');
  const scriptPath = join(packageRoot, 'scripts', cmd.script!);

  if (!existsSync(scriptPath)) {
    console.error(`❌ Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Make sure script is executable
  try {
    execSync(`chmod +x ${scriptPath}`, { stdio: 'ignore' });
  } catch (error) {
    // Ignore errors on chmod (may not have permission)
  }

  // Run the script from the user's current directory
  // Pass the package root so scripts can reference CDK files
  try {
    execSync(scriptPath, {
      stdio: 'inherit',
      cwd: process.cwd(), // User's project directory
      env: {
        ...process.env,
        // Ensure AWS region is set
        AWS_REGION: process.env.AWS_REGION || 'us-east-1',
        // Pass package root to scripts
        AWS_WORKFLOW_PACKAGE_ROOT: packageRoot,
      },
    });
  } catch (error) {
    process.exit((error as any).status || 1);
  }
}

// Main
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

runCommand(command);
