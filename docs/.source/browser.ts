// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<
  typeof Config,
  import('fumadocs-mdx/runtime/types').InternalTypeConfig & {
    DocData: {};
  } & {
    DocData: {
      docs: {
        /**
         * Last modified date of document file, obtained from version control.
         *
         */
        lastModified?: Date;
      };
    };
  }
>();
const browserCollections = {
  docs: create.doc('docs', {
    'api-reference/index.mdx': () =>
      import('../content/docs/api-reference/index.mdx?collection=docs'),
    'errors/corrupted-event-log.mdx': () =>
      import('../content/docs/errors/corrupted-event-log.mdx?collection=docs'),
    'errors/fetch-in-workflow.mdx': () =>
      import('../content/docs/errors/fetch-in-workflow.mdx?collection=docs'),
    'errors/hook-conflict.mdx': () =>
      import('../content/docs/errors/hook-conflict.mdx?collection=docs'),
    'errors/index.mdx': () =>
      import('../content/docs/errors/index.mdx?collection=docs'),
    'errors/node-js-module-in-workflow.mdx': () =>
      import(
        '../content/docs/errors/node-js-module-in-workflow.mdx?collection=docs'
      ),
    'errors/serialization-failed.mdx': () =>
      import('../content/docs/errors/serialization-failed.mdx?collection=docs'),
    'errors/start-invalid-workflow-function.mdx': () =>
      import(
        '../content/docs/errors/start-invalid-workflow-function.mdx?collection=docs'
      ),
    'errors/timeout-in-workflow.mdx': () =>
      import('../content/docs/errors/timeout-in-workflow.mdx?collection=docs'),
    'errors/webhook-invalid-respond-with-value.mdx': () =>
      import(
        '../content/docs/errors/webhook-invalid-respond-with-value.mdx?collection=docs'
      ),
    'errors/webhook-response-not-sent.mdx': () =>
      import(
        '../content/docs/errors/webhook-response-not-sent.mdx?collection=docs'
      ),
    'ai/chat-session-modeling.mdx': () =>
      import('../content/docs/ai/chat-session-modeling.mdx?collection=docs'),
    'ai/defining-tools.mdx': () =>
      import('../content/docs/ai/defining-tools.mdx?collection=docs'),
    'ai/human-in-the-loop.mdx': () =>
      import('../content/docs/ai/human-in-the-loop.mdx?collection=docs'),
    'ai/index.mdx': () =>
      import('../content/docs/ai/index.mdx?collection=docs'),
    'ai/message-queueing.mdx': () =>
      import('../content/docs/ai/message-queueing.mdx?collection=docs'),
    'ai/resumable-streams.mdx': () =>
      import('../content/docs/ai/resumable-streams.mdx?collection=docs'),
    'ai/sleep-and-delays.mdx': () =>
      import('../content/docs/ai/sleep-and-delays.mdx?collection=docs'),
    'ai/streaming-updates-from-tools.mdx': () =>
      import(
        '../content/docs/ai/streaming-updates-from-tools.mdx?collection=docs'
      ),
    'foundations/common-patterns.mdx': () =>
      import('../content/docs/foundations/common-patterns.mdx?collection=docs'),
    'foundations/errors-and-retries.mdx': () =>
      import(
        '../content/docs/foundations/errors-and-retries.mdx?collection=docs'
      ),
    'foundations/hooks.mdx': () =>
      import('../content/docs/foundations/hooks.mdx?collection=docs'),
    'foundations/idempotency.mdx': () =>
      import('../content/docs/foundations/idempotency.mdx?collection=docs'),
    'foundations/index.mdx': () =>
      import('../content/docs/foundations/index.mdx?collection=docs'),
    'foundations/serialization.mdx': () =>
      import('../content/docs/foundations/serialization.mdx?collection=docs'),
    'foundations/starting-workflows.mdx': () =>
      import(
        '../content/docs/foundations/starting-workflows.mdx?collection=docs'
      ),
    'foundations/streaming.mdx': () =>
      import('../content/docs/foundations/streaming.mdx?collection=docs'),
    'foundations/workflows-and-steps.mdx': () =>
      import(
        '../content/docs/foundations/workflows-and-steps.mdx?collection=docs'
      ),
    'deploying/building-a-world.mdx': () =>
      import('../content/docs/deploying/building-a-world.mdx?collection=docs'),
    'deploying/index.mdx': () =>
      import('../content/docs/deploying/index.mdx?collection=docs'),
    'getting-started/astro.mdx': () =>
      import('../content/docs/getting-started/astro.mdx?collection=docs'),
    'getting-started/express.mdx': () =>
      import('../content/docs/getting-started/express.mdx?collection=docs'),
    'getting-started/fastify.mdx': () =>
      import('../content/docs/getting-started/fastify.mdx?collection=docs'),
    'getting-started/hono.mdx': () =>
      import('../content/docs/getting-started/hono.mdx?collection=docs'),
    'getting-started/index.mdx': () =>
      import('../content/docs/getting-started/index.mdx?collection=docs'),
    'getting-started/nestjs.mdx': () =>
      import('../content/docs/getting-started/nestjs.mdx?collection=docs'),
    'getting-started/next.mdx': () =>
      import('../content/docs/getting-started/next.mdx?collection=docs'),
    'getting-started/nitro.mdx': () =>
      import('../content/docs/getting-started/nitro.mdx?collection=docs'),
    'getting-started/nuxt.mdx': () =>
      import('../content/docs/getting-started/nuxt.mdx?collection=docs'),
    'getting-started/sveltekit.mdx': () =>
      import('../content/docs/getting-started/sveltekit.mdx?collection=docs'),
    'getting-started/vite.mdx': () =>
      import('../content/docs/getting-started/vite.mdx?collection=docs'),
    'observability/index.mdx': () =>
      import('../content/docs/observability/index.mdx?collection=docs'),
    'how-it-works/code-transform.mdx': () =>
      import('../content/docs/how-it-works/code-transform.mdx?collection=docs'),
    'how-it-works/event-sourcing.mdx': () =>
      import('../content/docs/how-it-works/event-sourcing.mdx?collection=docs'),
    'how-it-works/framework-integrations.mdx': () =>
      import(
        '../content/docs/how-it-works/framework-integrations.mdx?collection=docs'
      ),
    'how-it-works/understanding-directives.mdx': () =>
      import(
        '../content/docs/how-it-works/understanding-directives.mdx?collection=docs'
      ),
    'api-reference/workflow-ai/durable-agent.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-ai/durable-agent.mdx?collection=docs'
      ),
    'api-reference/workflow-ai/index.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-ai/index.mdx?collection=docs'
      ),
    'api-reference/workflow-ai/workflow-chat-transport.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-ai/workflow-chat-transport.mdx?collection=docs'
      ),
    'api-reference/workflow-next/index.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-next/index.mdx?collection=docs'
      ),
    'api-reference/workflow-next/with-workflow.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-next/with-workflow.mdx?collection=docs'
      ),
    'api-reference/workflow/create-hook.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/create-hook.mdx?collection=docs'
      ),
    'api-reference/workflow/create-webhook.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/create-webhook.mdx?collection=docs'
      ),
    'api-reference/workflow/define-hook.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/define-hook.mdx?collection=docs'
      ),
    'api-reference/workflow/fatal-error.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/fatal-error.mdx?collection=docs'
      ),
    'api-reference/workflow/fetch.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/fetch.mdx?collection=docs'
      ),
    'api-reference/workflow/get-step-metadata.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/get-step-metadata.mdx?collection=docs'
      ),
    'api-reference/workflow/get-workflow-metadata.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/get-workflow-metadata.mdx?collection=docs'
      ),
    'api-reference/workflow/get-writable.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/get-writable.mdx?collection=docs'
      ),
    'api-reference/workflow/index.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/index.mdx?collection=docs'
      ),
    'api-reference/workflow/retryable-error.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/retryable-error.mdx?collection=docs'
      ),
    'api-reference/workflow/sleep.mdx': () =>
      import(
        '../content/docs/api-reference/workflow/sleep.mdx?collection=docs'
      ),
    'deploying/world/local-world.mdx': () =>
      import('../content/docs/deploying/world/local-world.mdx?collection=docs'),
    'deploying/world/postgres-world.mdx': () =>
      import(
        '../content/docs/deploying/world/postgres-world.mdx?collection=docs'
      ),
    'deploying/world/vercel-world.mdx': () =>
      import(
        '../content/docs/deploying/world/vercel-world.mdx?collection=docs'
      ),
    'api-reference/workflow-api/get-hook-by-token.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/get-hook-by-token.mdx?collection=docs'
      ),
    'api-reference/workflow-api/get-run.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/get-run.mdx?collection=docs'
      ),
    'api-reference/workflow-api/get-world.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/get-world.mdx?collection=docs'
      ),
    'api-reference/workflow-api/index.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/index.mdx?collection=docs'
      ),
    'api-reference/workflow-api/resume-hook.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/resume-hook.mdx?collection=docs'
      ),
    'api-reference/workflow-api/resume-webhook.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/resume-webhook.mdx?collection=docs'
      ),
    'api-reference/workflow-api/start.mdx': () =>
      import(
        '../content/docs/api-reference/workflow-api/start.mdx?collection=docs'
      ),
  }),
};
export default browserCollections;
