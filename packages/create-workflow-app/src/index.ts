import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      {
        title: 'Creating example workflow',
        task: async (message) => {
          message(`Creating example workflow`);
          mkdirSync(path.join(projectPath, 'workflows'));
          const workflowContent = `import { FatalError, sleep } from "workflow";

export async function handleUserSignup(email: string) {
 "use workflow"; 

 const user = await createUser(email);
 await sendWelcomeEmail(user);

 await sleep("5s"); // Pause for 5s - doesn't consume any resources
 await sendOnboardingEmail(user);

 return { userId: user.id, status: "onboarded" };
}
 
async function createUser(email: string) {
  "use step"; 
  console.log(\`Creating user with email: \${email}\`);
  // Full Node.js access - database calls, APIs, etc.
  return { id: crypto.randomUUID(), email };
}
async function sendWelcomeEmail(user: { id: string; email: string; }) {
  "use step"; 
  console.log(\`Sending welcome email to user: \${user.id}\`);
  if (Math.random() < 0.3) {
  // By default, steps will be retried for unhandled errors
   throw new Error("Retryable!");
  }
}
async function sendOnboardingEmail(user: { id: string; email: string}) {
 "use step"; 
  if (!user.email.includes("@")) {
    // To skip retrying, throw a FatalError instead
    throw new FatalError("Invalid Email");
  }
 console.log(\`Sending onboarding email to user: \${user.id}\`);
}`;
          writeFileSync(
            path.join(projectPath, 'workflows', 'user-signup.ts'),
            workflowContent
          );
          return `Created example workflow in ${chalk.green(path.join(projectPath, 'workflows', 'user-signup.ts'))}`;
        },
      },
    ]);
  }
}
