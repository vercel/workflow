---
"@workflow/astro": patch
"@workflow/cli": patch
"@workflow/core": patch
"@workflow/nitro": patch
"@workflow/sveltekit": patch
"@workflow/web": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Drop dependencies that are never loaded at runtime, so installing `workflow` downloads less: `@aws-sdk/credential-provider-web-identity` and `debug` from `@workflow/core`; `date-fns` (replaced by a small relative-time formatter with the same output), `chokidar`, `ora`, `esbuild`, `@swc/core` and other build-only packages from `@workflow/cli`; `@vercel/queue` from `@workflow/world-local` and `@workflow/world-postgres` (only its types were used); `swr` from `@workflow/web` (already bundled into its build); and `@swc/core`, `@workflow/swc-plugin`, `exsolve` and `pathe` from the framework integrations that do not import them.

If you use `awsCredentialsProvider` from `@vercel/functions/oidc` without an AWS SDK client, install `@aws-sdk/credential-provider-web-identity` or switch to `@vercel/oidc-aws-credentials-provider`.
