---
"@workflow/nest": minor
---

Harden the NestJS integration against the framework features a real application uses. Fastify applications now boot correctly, queue deliveries are no longer capped at 100, `app.enableVersioning()` no longer moves the workflow routes, `setGlobalPrefix(prefix, { exclude })` is honoured, `isWorkflowRequest(context)` export added, the Vercel app function is bundled for the runtime it is deployed on, `--external <pkgs>` is honored, and the builder warns when a second copy of `@nestjs/core` is present
