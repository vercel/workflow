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
import { parse as parseJSON, stringify as stringifyJSON } from 'comment-json';
import { BaseCommand } from '../base.js';

const execAsync = promisify(exec);

const templates = {
  next: {
    name: 'Next.js',
  },
  hono: {
    name: 'Hono',
  },
  nitro: {
    name: 'Nitro',
  },
  sveltekit: {
    name: 'SvelteKit',
  },
  nuxt: {
    name: 'Nuxt',
  },
};

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
      options: Object.keys(templates),
      default: 'next',
    }),
    packageManager: Flags.string({
      description: 'package manager to use',
      options: ['npm', 'pnpm', 'yarn', 'bun'],
      default: 'npm',
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
        options: Object.entries(templates).map(([key, value]) => ({
          label: value.name,
          value: key,
        })),
        initialValue: 'next',
      })) as string;

      if (isCancel(template)) {
        cancel('Cancelled workflow setup');
        return;
      }
    }

    const packageManager = (await select({
      message: 'What package manager would you like to use?',
      options: [
        { label: 'npm', value: 'npm' },
        { label: 'pnpm', value: 'pnpm' },
        { label: 'yarn', value: 'yarn' },
        { label: 'bun', value: 'bun', disabled: true },
      ],
    })) as string;

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
        title: `Creating ${templates[template as keyof typeof templates].name} app`,
        enabled: createNewProject,
        task: async (message) => {
          message(
            `Creating a new ${templates[template as keyof typeof templates].name} app`
          );
          switch (template) {
            case 'next':
              await execAsync(
                `npx create-next-app@latest ${projectName} --yes`
              );
              return `Created Next.js app in ${chalk.cyan(projectPath)}`;
            case 'hono':
              throw new Error('Hono is not supported yet');
            case 'nitro':
              await execAsync(
                `npx giget@latest nitro ${projectName} --install`
              );
              return `Created Nitro app in ${chalk.cyan(projectPath)}`;
            case 'nuxt':
              await execAsync(
                `npm create nuxt@latest ${projectName} -- --packageManager ${packageManager} --gitInit --no-modules`
              );
              return `Created Nuxt app in ${chalk.cyan(projectPath)}`;
            case 'sveltekit':
              await execAsync(
                `npx sv create ${projectName} --template=minimal --types=ts --no-add-ons`
              );
              return `Created SvelteKit app in ${chalk.cyan(projectPath)}`;
            default:
              throw new Error(`Unsupported template: ${template}`);
          }
        },
      },
      {
        title:
          template === 'next' ||
          template === 'nitro' ||
          template === 'nuxt' ||
          template === 'sveltekit'
            ? 'Installing `workflow` package'
            : 'Installing `workflow` and `nitro` package',
        task: async (message) => {
          message(`Installing \`workflow\` package`);
          switch (template) {
            case 'next':
            case 'nitro':
            case 'nuxt':
            case 'sveltekit':
              await execAsync(
                `cd ${projectPath} && ${packageManager} i workflow`
              );
              return `Installed \`workflow\` package`;
            case 'hono':
              await execAsync(
                `cd ${projectPath} && ${packageManager} i workflow nitro`
              );
              return `Installed \`workflow\` and \`nitro\` package`;
            default:
              throw new Error(`Unsupported template: ${template}`);
          }
        },
      },
      {
        title: 'Configuring Nitro config',
        enabled: template === 'nitro',
        task: async (message) => {
          message('Configuring Nitro config');
          const nitroConfig = `import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
	compatibilityDate: "latest",
	srcDir: "server",
	imports: false,
	modules: ["workflow/nitro"],
});
`;

          writeFileSync(path.join(projectPath, 'nitro.config.ts'), nitroConfig);

          return 'Configured Nitro config';
        },
      },
      {
        title: 'Configuring Nuxt config',
        enabled: template === 'nuxt',
        task: async (message) => {
          message('Configuring Nuxt config');
          const nuxtConfig = `import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  modules: ["workflow/nuxt"],
  compatibilityDate: "latest",
});
`;

          writeFileSync(path.join(projectPath, 'nuxt.config.ts'), nuxtConfig);

          return 'Configured Nuxt config';
        },
      },
      {
        title: 'Configuring Vite config',
        enabled: template === 'sveltekit',
        task: async (message) => {
          message('Configuring Vite config');
          let viteConfig = readFileSync(
            path.join(projectPath, 'vite.config.ts'),
            'utf8'
          );
          viteConfig = viteConfig.replace(
            /import { sveltekit } from ['"]@sveltejs\/kit\/vite['"];/g,
            `import { sveltekit } from '@sveltejs/kit/vite';\nimport { workflowPlugin } from 'workflow/sveltekit';`
          );
          viteConfig = viteConfig.replace(
            /plugins: \[sveltekit\(\)\]/g,
            'plugins: [sveltekit(), workflowPlugin()]'
          );
          writeFileSync(path.join(projectPath, 'vite.config.ts'), viteConfig);
          return 'Configured Vite config';
        },
      },
      {
        title: 'Configuring TypeScript intellisense',
        enabled: useTsPlugin && template !== 'nuxt',
        task: async (message) => {
          message(`Configuring TypeScript intellisense`);
          const tsConfig = parseJSON(
            readFileSync(path.join(projectPath, 'tsconfig.json'), 'utf8')
          ) as any;
          if (!tsConfig.compilerOptions) {
            tsConfig.compilerOptions = {};
          }
          if (!tsConfig.compilerOptions.plugins) {
            tsConfig.compilerOptions.plugins = [];
          }
          tsConfig.compilerOptions.plugins.push({
            name: 'workflow',
          });
          writeFileSync(
            path.join(projectPath, 'tsconfig.json'),
            stringifyJSON(tsConfig, null, 2)
          );
          return 'Configured TypeScript intellisense';
        },
      },
      {
        title: 'Configuring Next.js config',
        enabled: template === 'next',
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
          let workflowsPath: string;
          if (template === 'nitro' || template === 'nuxt') {
            workflowsPath = path.join(projectPath, 'server', 'workflows');
          } else if (template === 'sveltekit') {
            // TODO: Should be src/workflows (waiting on new workflow release)
            workflowsPath = path.join(projectPath, 'workflows');
          } else {
            workflowsPath = path.join(projectPath, 'workflows');
          }
          mkdirSync(workflowsPath, { recursive: true });
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
          switch (template) {
            case 'next':
              {
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
              }
              return `Created API route handler in ${chalk.cyan(path.join(projectPath, 'app', 'api', 'signup', 'route.ts'))}`;
            case 'nitro': {
              const apiPath = path.join(projectPath, 'server', 'api');
              mkdirSync(apiPath, { recursive: true });
              writeFileSync(
                path.join(apiPath, 'signup.post.ts'),
                `import { start } from 'workflow/api';
import { defineEventHandler, readBody } from 'h3';
import { handleUserSignup } from "../../workflows/user-signup";

export default defineEventHandler(async (event) => {
  const { email } = await readBody(event);

  // Executes asynchronously and doesn't block your app
  await start(handleUserSignup, [email]);

  return Response.json({
    message: "User signup workflow started",
  });
});`
              );
              return `Created API route handler in ${chalk.cyan(path.join(projectPath, 'server', 'api', 'signup.post.ts'))}`;
            }
            case 'nuxt': {
              const apiPath = path.join(projectPath, 'server', 'api');
              mkdirSync(apiPath, { recursive: true });
              writeFileSync(
                path.join(apiPath, 'signup.post.ts'),
                `import { start } from 'workflow/api';
import { defineEventHandler, readBody } from 'h3';
import { handleUserSignup } from "../workflows/user-signup";

export default defineEventHandler(async (event) => {
  const { email } = await readBody(event);

  // Executes asynchronously and doesn't block your app
  await start(handleUserSignup, [email]);

  return {
    message: "User signup workflow started",
  };
});`
              );
              return `Created API route handler in ${chalk.cyan(path.join(projectPath, 'server', 'api', 'signup.post.ts'))}`;
            }
            case 'sveltekit': {
              const apiPath = path.join(
                projectPath,
                'src',
                'routes',
                'api',
                'signup'
              );
              mkdirSync(apiPath, { recursive: true });
              writeFileSync(
                path.join(apiPath, '+server.ts'),
                `import { start } from "workflow/api";
import { handleUserSignup } from "../../../../workflows/user-signup";
import { json, type RequestHandler } from "@sveltejs/kit";

export const POST: RequestHandler = async ({
  request,
}: {
  request: Request;
}) => {
  const { email } = await request.json();

  // Executes asynchronously and doesn't block your app
  await start(handleUserSignup, [email]);

  return json({ message: "User signup workflow started" });
};`
              );
              return `Created API route handler in ${chalk.cyan(path.join(projectPath, 'src', 'routes', 'api', 'signup', '+server.ts'))}`;
            }
            default:
              throw new Error(`Unsupported template: ${template}`);
          }
        },
      },
    ]);

    cancel('Cancelled workflow setup');

    const port = template === 'sveltekit' ? '5173' : '3000';

    outro(
      `${chalk.green('Success!')} Next steps:
     Run ${chalk.dim(`${createNewProject ? `cd ${projectName} && ` : ''}${packageManager} run dev`)} to start the development server
     Trigger the workflow: ${chalk.dim(`curl -X POST --json '{"email":"hello@example.com"}' http://localhost:${port}/api/signup`)}`
    );
  }
}
