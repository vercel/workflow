import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

interface InitOptions {
  example?: boolean;
  stackName?: string;
  region?: string;
}

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  console.log('🚀 Initializing AWS Workflow...\n');

  try {
    // 1. Check if this is a Next.js project
    if (
      !existsSync(join(cwd, 'next.config.ts')) &&
      !existsSync(join(cwd, 'next.config.js'))
    ) {
      console.error('❌ Error: No Next.js project found in current directory');
      console.log(
        '   Please run this command from the root of your Next.js project'
      );
      process.exit(1);
    }

    // 2. Create infrastructure directory
    console.log('📁 Creating infrastructure directory...');
    const infraDir = join(cwd, 'infrastructure');
    mkdirSync(infraDir, { recursive: true });
    mkdirSync(join(infraDir, 'lib'), { recursive: true });
    mkdirSync(join(infraDir, 'lambda', 'worker'), { recursive: true });

    // 3. Copy template files
    console.log('📝 Creating infrastructure files...');
    const templatesDir = join(__dirname, '../../templates');

    copyTemplate(
      join(templatesDir, 'cdk-stack.ts.template'),
      join(infraDir, 'lib', 'workflow-stack.ts'),
      { stackName: options.stackName || 'workflow-dev' }
    );

    copyTemplate(
      join(templatesDir, 'lambda-handler.ts.template'),
      join(infraDir, 'lambda', 'worker', 'index.ts')
    );

    copyTemplate(
      join(templatesDir, 'cdk.json.template'),
      join(infraDir, 'cdk.json')
    );

    copyTemplate(
      join(templatesDir, 'infrastructure-package.json.template'),
      join(infraDir, 'package.json'),
      { projectName: getProjectName(cwd) }
    );

    copyTemplate(
      join(templatesDir, 'tsconfig.json.template'),
      join(infraDir, 'tsconfig.json')
    );

    copyTemplate(
      join(templatesDir, 'workflow-stack-bin.ts.template'),
      join(infraDir, 'bin', 'workflow-stack.ts'),
      {
        stackName: options.stackName || 'workflow-dev',
        region: options.region || 'us-east-1',
      }
    );

    // 4. Update or create instrumentation.ts
    console.log('⚙️  Configuring Next.js...');
    createInstrumentation(cwd);

    // 5. Update next.config
    updateNextConfig(cwd);

    // 6. Create .env.local template
    createEnvTemplate(cwd, options);

    // 7. Create example workflow if requested
    if (options.example) {
      console.log('📦 Creating example workflow...');
      createExampleWorkflow(cwd);
    }

    // 8. Update package.json scripts
    console.log('🔧 Updating package.json scripts...');
    updatePackageScripts(cwd);

    console.log('\n✅ AWS Workflow initialized successfully!\n');
    console.log('📚 Next steps:\n');
    console.log('1. Install infrastructure dependencies:');
    console.log('   cd infrastructure && npm install\n');
    console.log('2. Configure AWS credentials (if not already done)');
    console.log('   aws configure\n');
    console.log('3. Deploy your infrastructure:');
    console.log('   npm run deploy\n');

    if (options.example) {
      console.log('4. Check out the example workflow:');
      console.log('   app/workflows/example.ts\n');
    }
  } catch (error) {
    console.error('\n❌ Initialization failed:', error);
    process.exit(1);
  }
}

function copyTemplate(
  src: string,
  dest: string,
  replacements: Record<string, string> = {}
) {
  let content = readFileSync(src, 'utf-8');

  // Replace template variables
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

function getProjectName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    return pkg.name || 'my-app';
  } catch {
    return 'my-app';
  }
}

function createInstrumentation(cwd: string) {
  const instrumentationPath = join(cwd, 'instrumentation.ts');

  if (existsSync(instrumentationPath)) {
    console.log('   ⚠️  instrumentation.ts already exists, skipping...');
    return;
  }

  const content = `export async function register() {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    console.log('✅ Workflow initialized with AWS backend');
    console.log(\`   Region: \${process.env.AWS_REGION || 'not set'}\`);
    console.log(\`   World: \${process.env.WORKFLOW_TARGET_WORLD || 'not set'}\`);
  }
}
`;

  writeFileSync(instrumentationPath, content);
  console.log('   ✓ Created instrumentation.ts');
}

function updateNextConfig(cwd: string) {
  const configPath = join(cwd, 'next.config.ts');

  if (!existsSync(configPath)) {
    console.log('   ⚠️  next.config.ts not found, skipping...');
    return;
  }

  let config = readFileSync(configPath, 'utf-8');

  // Check if withWorkflow is already added
  if (config.includes('withWorkflow')) {
    console.log('   ⚠️  withWorkflow already configured, skipping...');
    return;
  }

  // Add withWorkflow import and wrap config
  if (!config.includes('workflow/next')) {
    config = `import { withWorkflow } from "workflow/next";\n${config}`;
  }

  // Wrap the default export
  config = config.replace(
    /export default (\w+);?/,
    'export default withWorkflow($1);'
  );

  writeFileSync(configPath, config);
  console.log('   ✓ Updated next.config.ts with withWorkflow()');
}

function createEnvTemplate(cwd: string, options: InitOptions) {
  const content = `# AWS Workflow Configuration
# Generated by aws-workflow init

# Tell Workflow SDK to use AWS backend
WORKFLOW_TARGET_WORLD=aws-workflow

# AWS Configuration
AWS_REGION=${options.region || 'us-east-1'}

# The following values will be populated after running 'npm run deploy'
# WORKFLOW_AWS_RUNS_TABLE=
# WORKFLOW_AWS_STEPS_TABLE=
# WORKFLOW_AWS_EVENTS_TABLE=
# WORKFLOW_AWS_HOOKS_TABLE=
# WORKFLOW_AWS_STREAMS_TABLE=
# WORKFLOW_AWS_WORKFLOW_QUEUE_URL=
# WORKFLOW_AWS_STEP_QUEUE_URL=
# WORKFLOW_AWS_STREAM_BUCKET=
`;

  const envPath = join(cwd, '.env.local');

  if (existsSync(envPath)) {
    // Append to existing file
    const existing = readFileSync(envPath, 'utf-8');
    if (!existing.includes('WORKFLOW_TARGET_WORLD')) {
      writeFileSync(envPath, existing + '\n\n' + content);
      console.log('   ✓ Updated .env.local');
    } else {
      console.log('   ⚠️  .env.local already has workflow config, skipping...');
    }
  } else {
    writeFileSync(envPath, content);
    console.log('   ✓ Created .env.local');
  }
}

function createExampleWorkflow(cwd: string) {
  const workflowsDir = join(cwd, 'app', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });

  const examplePath = join(workflowsDir, 'example.ts');

  if (existsSync(examplePath)) {
    console.log('   ⚠️  Example workflow already exists, skipping...');
    return;
  }

  const content = `import { sleep, FatalError } from "workflow";

/**
 * Example workflow: User onboarding
 * 
 * Demonstrates:
 * - Step functions with "use step"
 * - Workflow orchestration with "use workflow"
 * - Automatic retries and error handling
 * - Durable sleep
 */
export async function onboardUser(email: string, name: string) {
  "use workflow";

  console.log(\`Starting onboarding for \${email}\`);

  // Step 1: Create user account
  const user = await createUserAccount(email, name);
  console.log(\`Created user: \${user.id}\`);

  // Step 2: Send welcome email
  await sendWelcomeEmail(user);
  console.log(\`Sent welcome email to \${email}\`);

  // Step 3: Wait before sending tips
  await sleep("24h"); // Durable sleep - doesn't consume resources!

  // Step 4: Send onboarding tips
  await sendOnboardingTips(user);
  console.log(\`Sent onboarding tips to \${email}\`);

  return { userId: user.id, status: "onboarded" };
}

async function createUserAccount(email: string, name: string) {
  "use step";

  // This is a step - it can fail and will be retried automatically
  // Simulate API call or database operation
  if (!email.includes("@")) {
    throw new FatalError("Invalid email format");
  }

  return {
    id: crypto.randomUUID(),
    email,
    name,
    createdAt: new Date().toISOString(),
  };
}

async function sendWelcomeEmail(user: { id: string; email: string; name: string }) {
  "use step";

  // Simulate email sending
  console.log(\`Sending welcome email to \${user.email}\`);

  // This step will be retried automatically if it fails
  // (unless you throw a FatalError)
  
  return { sent: true, timestamp: new Date().toISOString() };
}

async function sendOnboardingTips(user: { id: string; email: string; name: string }) {
  "use step";

  console.log(\`Sending onboarding tips to \${user.email}\`);
  
  return { sent: true, timestamp: new Date().toISOString() };
}
`;

  writeFileSync(examplePath, content);
  console.log('   ✓ Created app/workflows/example.ts');

  // Create API route to trigger the workflow
  const apiDir = join(cwd, 'app', 'api', 'onboard');
  mkdirSync(apiDir, { recursive: true });

  const apiContent = `import { onboardUser } from "@/workflows/example";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

export async function POST(request: Request) {
  const { email, name } = await request.json();

  if (!email || !name) {
    return NextResponse.json(
      { error: "Email and name are required" },
      { status: 400 }
    );
  }

  // Start the workflow asynchronously
  const run = await start(onboardUser, [email, name]);

  return NextResponse.json({
    message: "Onboarding workflow started",
    runId: run.runId,
  });
}
`;

  writeFileSync(join(apiDir, 'route.ts'), apiContent);
  console.log('   ✓ Created app/api/onboard/route.ts');
}

function updatePackageScripts(cwd: string) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  pkg.scripts = {
    ...pkg.scripts,
    'build:infra': 'cd infrastructure && npm run build',
    deploy: 'npm run build && aws-workflow deploy',
    'destroy:infra': 'aws-workflow destroy',
  };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('   ✓ Added deployment scripts to package.json');
}
