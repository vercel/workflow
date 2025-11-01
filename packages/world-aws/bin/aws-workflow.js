#!/usr/bin/env node

const { Command } = require('commander');
const pkg = require('../package.json');

// Import commands (these will be compiled from TypeScript)
try {
  var { init } = require('../dist/cli/commands/init');
  var { deploy } = require('../dist/cli/commands/deploy');
  var { build } = require('../dist/cli/commands/build');
  var { destroy } = require('../dist/cli/commands/destroy');
} catch (error) {
  console.error('Error: aws-workflow is not properly installed.');
  console.error('Please run: npm install aws-workflow');
  process.exit(1);
}

const program = new Command();

program
  .name('aws-workflow')
  .description('AWS infrastructure for Workflow DevKit')
  .version(pkg.version);

program
  .command('init')
  .description('Initialize AWS Workflow in your Next.js project')
  .option('--example', 'Include example workflow')
  .option('--stack-name <name>', 'CDK stack name', 'workflow-dev')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .action(init);

program
  .command('build')
  .description('Build workflow bundles and Lambda function')
  .action(build);

program
  .command('deploy')
  .description('Deploy Next.js app and AWS infrastructure')
  .option('--stack-name <name>', 'CDK stack name', 'workflow-dev')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .option('--skip-build', 'Skip Next.js build step')
  .action(deploy);

program
  .command('destroy')
  .description('Destroy AWS infrastructure')
  .option('--stack-name <name>', 'CDK stack name', 'workflow-dev')
  .option('--force', 'Skip confirmation')
  .action(destroy);

program.parse();
