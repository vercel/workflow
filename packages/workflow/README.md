<div align="center">
  <a href="https://workflow-sdk.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://workflow-sdk.dev/workflow-circle-symbol-dark.svg">
      <img alt="Workflow SDK logo" src="https://workflow-sdk.dev/workflow-circle-symbol-light.svg" height="128">
    </picture>
  </a>
  <h1>Workflow SDK</h1>

<a href="https://vercel.com"><img alt="Vercel logo" src="https://img.shields.io/badge/MADE%20BY%20Vercel-000000.svg?style=for-the-badge&logo=Vercel&labelColor=000"></a>
<a href="https://www.npmjs.com/package/workflow"><img alt="NPM version" src="https://img.shields.io/npm/v/workflow?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/workflow/blob/main/LICENSE.md"><img alt="License" src="https://img.shields.io/npm/l/workflow.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/workflow/discussions"><img alt="Join the community on GitHub" src="https://img.shields.io/badge/Join%20the%20community-blueviolet.svg?style=for-the-badge&logo=Github&labelColor=000000&logoWidth=20"></a>

</div>

[Workflow SDK](https://workflow-sdk.dev) is an open-source framework for durable
execution in TypeScript and JavaScript. Add simple directives to ordinary async
functions to get state persistence, automatic retries, suspension and
resumption, and end-to-end observability without managing queues or adopting a
separate orchestration DSL.

## Async functions are the authoring interface

A workflow is plain TypeScript:

```ts
import { sleep } from 'workflow';

type User = {
  id: string;
  email: string;
};

export async function onboardUser(email: string) {
  'use workflow';

  const user = await createUser(email);
  await sendEmail(user, 'Welcome!');
  await sleep('1 day');
  await sendEmail(user, 'Here is what to do next.');

  return { userId: user.id };
}

async function createUser(email: string): Promise<User> {
  'use step';

  return { id: crypto.randomUUID(), email };
}

async function sendEmail(user: User, message: string) {
  'use step';

  console.log(`Sending "${message}" to ${user.email}`);
}
```

Workflow functions orchestrate deterministic control flow. Step functions do
the actual work with full runtime and npm package access, and retry
automatically when they fail. Completed step results are persisted to an event
log, so a workflow can resume after a restart without repeating completed side
effects. While waiting on steps, timers, or external events, it can suspend
without consuming compute.

Read [Workflows and Steps](https://workflow-sdk.dev/docs/foundations/workflows-and-steps)
for the execution model and core concepts.

## Quick start

Install the SDK in an existing project:

```bash
npm install workflow
```

Configure the integration for your framework. For example, with Next.js:

```ts
// next.config.ts
import { withWorkflow } from 'workflow/next';

export default withWorkflow({});
```

Then start a workflow from an API route, Server Action, or other server-side
code:

```ts
import { start } from 'workflow/api';
import { onboardUser } from './workflows/onboard-user';

await start(onboardUser, ['hello@example.com']);
```

Run your app normally, then open the local observability UI:

```bash
npm run dev
npx workflow web
```

Choose a framework in the
[getting-started guides](https://workflow-sdk.dev/docs/getting-started) for the
complete setup.

> [!NOTE]
> The `workflow` package includes its full documentation, so coding agents can
> read version-matched guides locally from `node_modules/workflow/docs`.

## Run anywhere

During development, Workflow SDK automatically uses its local backend with no
backend configuration. Deploy to Vercel for managed storage, queuing, scaling,
and observability, or self-host with the Postgres backend or a custom
[World](https://workflow-sdk.dev/docs/deploying).

## Community

The Workflow SDK community lives on
[GitHub Discussions](https://github.com/vercel/workflow/discussions), where you
can ask questions, share ideas, and show what you have built.

## Contributing

Contributions are welcome. Use
[issues](https://github.com/vercel/workflow/issues) and
[discussions](https://github.com/vercel/workflow/discussions) to collaborate
with the team and wider community.

## Security

Please do not open public issues for security vulnerabilities.

To participate in our Open Source Software Bug Bounty program, please email
[responsible.disclosure@vercel.com](mailto:responsible.disclosure@vercel.com).
We will add you to the program and provide further instructions for submitting
your report.
