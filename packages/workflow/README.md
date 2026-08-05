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

[Workflow SDK](https://workflow-sdk.dev) makes TypeScript and JavaScript
functions durable. It persists workflow progress, retries failed steps, and
provides built-in observability. Workflows can suspend without using compute
while they wait.

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

Run your app, then open the local observability UI in another terminal:

```bash
npm run dev
```

```bash
npx workflow web
```

Choose your framework in the
[getting-started guides](https://workflow-sdk.dev/docs/getting-started).

> [!NOTE]
> The `workflow` package includes its full documentation, so coding agents can
> read version-matched guides locally from `node_modules/workflow/docs`.

## Run anywhere

Local development uses the bundled backend with no configuration. Deploy to
Vercel for managed storage, queuing, scaling, and observability. To self-host,
use the Postgres backend or implement a custom
[World](https://workflow-sdk.dev/docs/deploying).

## Community

The Workflow SDK community lives on
[GitHub Discussions](https://github.com/vercel/workflow/discussions), where you
can ask questions, share ideas, and show what you have built.

## Contributing

Contributions are welcome. Use
[issues](https://github.com/vercel/workflow/issues) and
[discussions](https://github.com/vercel/workflow/discussions) to collaborate
with the team and wider community. By participating, you agree to our
[Code of Conduct](https://github.com/vercel/workflow/blob/main/CODE_OF_CONDUCT.md).

## Security

If you believe you have found a security vulnerability in Workflow SDK, we encourage you to **_responsibly disclose this and not open a public issue_**.

To participate in our Open Source Software Bug Bounty program, please email
[responsible.disclosure@vercel.com](mailto:responsible.disclosure@vercel.com).
We will add you to the program and provide further instructions for submitting
your report.
