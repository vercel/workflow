import { exec } from 'node:child_process';
import { readFile, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { confirm, intro, tasks, text } from '@clack/prompts';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';

const execAsync = promisify(exec);

export default class CreateWorkflowApp extends Command {
  static args = {
    projectName: Args.string(),
  };

  static flags = {
    yes: Flags.boolean({ char: 'y' }),
    // TODO: Add template flag
    // template: Flags.string({
    //   options: ['nextjs'],
    // }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CreateWorkflowApp);

    intro('create-workflow-app');

    const projectName =
      args.projectName ||
      ((await text({
        message: 'What is your project name?',
        placeholder: 'my-workflow-app',
        defaultValue: 'my-workflow-app',
      })) as string);

    const useTsPlugin =
      flags.yes ||
      ((await confirm({
        message: 'Configure TypeScript intellisense? (recommended)',
        initialValue: true,
      })) as boolean);

    const projectPath = path.join(process.cwd(), projectName);

    await tasks([
      {
        title: 'Creating Next.js app',
        task: async (message) => {
          message(`Creating a new Next.js app in ${chalk.green(projectPath)}`);
          await execAsync(`npx create-next-app@latest ${projectName} --yes`);
          return 'Created Next.js app';
        },
      },
      {
        title: 'Installing Workflow DevKit Dependencies',
        task: async (message) => {
          message(`Installing Workflow DevKit dependencies`);
          await execAsync(`cd ${projectPath} && pnpm add workflow`);
          return 'Installed Workflow DevKit dependencies';
        },
      },
      {
        title: 'Configuring TypeScript intellisense',
        enabled: useTsPlugin,
        task: async (message) => {
          message(`Configuring TypeScript intellisense`);
          const tsConfig = JSON.parse(
            readFileSync(path.join(projectPath, 'tsconfig.json'), 'utf8')
          );
          tsConfig.compilerOptions.plugins.push({
            name: 'workflow',
          });
          writeFileSync(
            path.join(projectPath, 'tsconfig.json'),
            JSON.stringify(tsConfig, null, 2)
          );
          return 'Configured TypeScript intellisense';
        },
      },
      {
        title: 'Configuring Next.js config',
        task: async (message) => {
          message(`Configuring Next.js config`);
          let nextConfig = readFileSync(
            path.join(projectPath, 'next.config.ts'),
            'utf8'
          );
          nextConfig = nextConfig.replace(
            /import type { NextConfig } from "next";/g,
            "import type { NextConfig } from 'next';\nimport { withWorkflow } from 'workflow/next';"
          );
          nextConfig = nextConfig.replace(
            /export default nextConfig;/g,
            'export default withWorkflow(nextConfig);'
          );
          writeFileSync(path.join(projectPath, 'next.config.ts'), nextConfig);
          return 'Configured Next.js config';
        },
      },
    ]);

    // this.logInfo('🚧 Project initialization is coming soon!');
    // this.logInfo('');
    // this.logInfo('This command will provide:');
    // this.logInfo('• Interactive project setup');
    // this.logInfo('• Multiple project templates');
    // this.logInfo('• Automatic configuration file generation');
    // this.logInfo('• Dependency installation');
    // this.logInfo('• Example workflows and steps');
    // this.logInfo('Or we might do a create-workflow-app package');
    // this.logInfo('');

    // if (flags.template) {
    //   this.logInfo(`Selected template: ${flags.template}`);
    // }

    // if (flags.yes) {
    //   this.logInfo('Auto-accept mode enabled');
    // }
  }
}
