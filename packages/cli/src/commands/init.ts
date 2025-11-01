import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  select,
  tasks,
  text,
} from '@clack/prompts';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';

const execAsync = promisify(exec);

export default class Init extends BaseCommand {
  static description = 'Initialize a new workflow project';

  static examples = [
    '$ workflow init',
    '$ workflow init --template nextjs',
    '$ workflow init --yes',
  ];

  static flags = {
    template: Flags.string({
      description: 'template to use',
      options: ['next', 'hono', 'nitro'],
      default: 'next',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'skip prompts and use defaults',
    }),
  };

  /**
   *
   * @returns true if the current directory is a Next.js app
   */
  private isNextApp(): boolean {
    const configFiles = [
      'next.config.js',
      'next.config.mjs',
      'next.config.ts',
      'next.config.cjs',
    ];

    return configFiles.some((file) =>
      existsSync(path.join(process.cwd(), file))
    );
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);

    intro('workflow init');

    let template = flags.template ?? 'next';

    const isNextApp = this.isNextApp();

    let createNewProject = true;

    if (isNextApp) {
      log.info('Detected Next.js app');

      createNewProject = (await confirm({
        message: 'Create a new project?',
        initialValue: true,
      })) as boolean;

      if (isCancel(createNewProject)) {
        cancel('Cancelled workflow setup');
        return;
      }
    }

    let projectName = 'my-workflow-app';

    if (createNewProject) {
      projectName =
        args.projectName ||
        ((await text({
          message: 'What is your project name?',
          placeholder: 'my-workflow-app',
          defaultValue: 'my-workflow-app',
        })) as string);

      if (isCancel(projectName)) {
        cancel('Cancelled workflow setup');
        return;
      }

      template = (await select({
        message: 'What template would you like to use?',
        options: [
          { label: 'Hono', value: 'hono', hint: 'via Nitro v3' },
          { label: 'Next.js', value: 'next' },
          {
            label: 'Nitro',
            value: 'nitro',
          },
        ],
        initialValue: 'next',
      })) as string;

      if (isCancel(template)) {
        cancel('Cancelled workflow setup');
        return;
      }
    }

    const useTsPlugin =
      flags.yes ||
      ((await confirm({
        message: `Configure TypeScript intellisense? ${chalk.dim('(recommended)')}`,
        initialValue: true,
      })) as boolean);

    if (isCancel(useTsPlugin)) {
      cancel('Cancelled workflow setup');
      return;
    }

    const projectPath = createNewProject
      ? path.join(process.cwd(), projectName)
      : process.cwd();

    await tasks([
      {
        title:
          template === 'next' ? 'Creating Next.js app' : 'Creating Hono app',
        enabled: createNewProject,
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

    cancel('Cancelled workflow setup');

    outro(
      `${chalk.green('Success!')} Next steps:
     Run ${chalk.dim(`${createNewProject ? `cd ${projectName} && ` : ''}npm run dev`)} to start the development server
     Trigger the workflow: ${chalk.dim('curl -X POST --json \'{"email":"hello@example.com"}\' http://localhost:3000/api/signup')}`
    );
  }
}
