import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { confirm, intro, outro, tasks, text } from '@clack/prompts';
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
        message: `Configure TypeScript intellisense? ${chalk.dim('(recommended)')}`,
        initialValue: true,
      })) as boolean);

    const projectPath = path.join(process.cwd(), projectName);

    await tasks([
      {
        title: 'Creating Next.js app',
        task: async (message) => {
          message('Creating a new Next.js app');
          await execAsync(`npx create-next-app@latest ${projectName} --yes`);
          return `Created Next.js app in ${chalk.cyan(projectPath)}`;
        },
      },
      {
        title: 'Installing `workflow` package',
        task: async (message) => {
          message(`Installing \`workflow\` package`);
          await execAsync(`cd ${projectPath} && pnpm add workflow`);
          return `Installed \`workflow\` package`;
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
          const workflowsPath = path.join(projectPath, 'workflows');
          mkdirSync(workflowsPath);
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
            path.join(workflowsPath, 'user-signup.ts'),
            workflowContent
          );
          return `Created example workflow in ${chalk.cyan(path.join(workflowsPath, 'user-signup.ts'))}`;
        },
      },
      {
        title: 'Creating API route handler',
        task: async (message) => {
          message(`Creating API route handler`);
          const apiPath = path.join(projectPath, 'app', 'api', 'signup');
          mkdirSync(apiPath, { recursive: true });
          writeFileSync(
            path.join(apiPath, 'route.ts'),
            `import { start } from 'workflow/api';
import { handleUserSignup } from "@/workflows/user-signup";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
 const { email } = await request.json();

 // Executes asynchronously and doesn't block your app
 await start(handleUserSignup, [email]);

 return NextResponse.json({
  message: "User signup workflow started",
 });
}`
          );
          return `Created API route handler in ${chalk.cyan(path.join(projectPath, 'app', 'api', 'signup', 'route.ts'))}`;
        },
      },
    ]);

    outro(
      `${chalk.green('Success!')} Next steps:
     Run ${chalk.dim(`cd ${projectName} && npm run dev`)} to start the development server
     Trigger the workflow: ${chalk.dim('curl -X POST --json \'{"email":"hello@example.com"}\' http://localhost:3000/api/signup')}`
    );
  }
}
