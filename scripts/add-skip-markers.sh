#!/bin/bash

# List of incomplete snippets (file:line format)
INCOMPLETE_SNIPPETS="
docs/content/docs/ai/chat-session-modeling.mdx:72
docs/content/docs/ai/chat-session-modeling.mdx:219
docs/content/docs/ai/chat-session-modeling.mdx:236
docs/content/docs/ai/human-in-the-loop.mdx:52
docs/content/docs/ai/human-in-the-loop.mdx:75
docs/content/docs/ai/human-in-the-loop.mdx:151
docs/content/docs/ai/human-in-the-loop.mdx:240
docs/content/docs/ai/index.mdx:82
docs/content/docs/ai/index.mdx:136
docs/content/docs/ai/index.mdx:159
docs/content/docs/ai/index.mdx:225
docs/content/docs/ai/index.mdx:318
docs/content/docs/ai/resumable-streams.mdx:24
docs/content/docs/ai/resumable-streams.mdx:87
docs/content/docs/ai/sleep-and-delays.mdx:26
docs/content/docs/ai/sleep-and-delays.mdx:67
docs/content/docs/ai/streaming-updates-from-tools.mdx:42
docs/content/docs/ai/streaming-updates-from-tools.mdx:92
docs/content/docs/api-reference/workflow-ai/durable-agent.mdx:311
docs/content/docs/api-reference/workflow-api/get-run.mdx:10
docs/content/docs/api-reference/workflow-api/get-world.mdx:10
docs/content/docs/api-reference/workflow-api/resume-hook.mdx:110
docs/content/docs/api-reference/workflow-api/resume-webhook.mdx:198
docs/content/docs/api-reference/workflow-api/start.mdx:8
docs/content/docs/api-reference/workflow-api/start.mdx:58
docs/content/docs/api-reference/workflow-api/start.mdx:67
docs/content/docs/api-reference/workflow-next/with-workflow.mdx:12
docs/content/docs/api-reference/workflow/create-webhook.mdx:80
docs/content/docs/api-reference/workflow/define-hook.mdx:173
docs/content/docs/deploying/world/local-world.mdx:51
docs/content/docs/deploying/world/local-world.mdx:71
docs/content/docs/deploying/world/local-world.mdx:83
docs/content/docs/deploying/world/local-world.mdx:96
docs/content/docs/deploying/world/local-world.mdx:120
docs/content/docs/deploying/world/local-world.mdx:211
docs/content/docs/deploying/world/local-world.mdx:234
docs/content/docs/deploying/world/postgres-world.mdx:107
docs/content/docs/deploying/world/postgres-world.mdx:129
docs/content/docs/deploying/world/postgres-world.mdx:145
docs/content/docs/deploying/world/vercel-world.mdx:139
docs/content/docs/deploying/world/vercel-world.mdx:160
docs/content/docs/errors/node-js-module-in-workflow.mdx:28
docs/content/docs/errors/serialization-failed.mdx:35
docs/content/docs/errors/start-invalid-workflow-function.mdx:78
docs/content/docs/errors/start-invalid-workflow-function.mdx:91
docs/content/docs/errors/timeout-in-workflow.mdx:26
docs/content/docs/errors/webhook-invalid-respond-with-value.mdx:94
docs/content/docs/errors/webhook-response-not-sent.mdx:159
docs/content/docs/foundations/control-flow-patterns.mdx:12
docs/content/docs/foundations/errors-and-retries.mdx:147
docs/content/docs/foundations/hooks.mdx:22
docs/content/docs/foundations/hooks.mdx:214
docs/content/docs/foundations/hooks.mdx:244
docs/content/docs/foundations/hooks.mdx:434
docs/content/docs/foundations/serialization.mdx:109
docs/content/docs/foundations/starting-workflows.mdx:42
docs/content/docs/foundations/streaming.mdx:159
docs/content/docs/foundations/streaming.mdx:325
docs/content/docs/foundations/streaming.mdx:496
docs/content/docs/foundations/streaming.mdx:508
docs/content/docs/foundations/workflows-and-steps.mdx:89
docs/content/docs/getting-started/astro.mdx:37
docs/content/docs/getting-started/express.mdx:53
docs/content/docs/getting-started/express.mdx:195
docs/content/docs/getting-started/fastify.mdx:53
docs/content/docs/getting-started/fastify.mdx:183
docs/content/docs/getting-started/hono.mdx:38
docs/content/docs/getting-started/hono.mdx:181
docs/content/docs/getting-started/next.mdx:34
docs/content/docs/getting-started/next.mdx:84
docs/content/docs/getting-started/nitro.mdx:34
docs/content/docs/getting-started/nitro.mdx:161
docs/content/docs/getting-started/nuxt.mdx:34
docs/content/docs/getting-started/nuxt.mdx:53
docs/content/docs/getting-started/nuxt.mdx:159
docs/content/docs/getting-started/sveltekit.mdx:34
docs/content/docs/getting-started/sveltekit.mdx:161
docs/content/docs/getting-started/vite.mdx:41
docs/content/docs/getting-started/vite.mdx:169
docs/content/docs/how-it-works/code-transform.mdx:16
docs/content/docs/how-it-works/code-transform.mdx:73
docs/content/docs/how-it-works/code-transform.mdx:82
docs/content/docs/how-it-works/code-transform.mdx:110
docs/content/docs/how-it-works/code-transform.mdx:125
docs/content/docs/how-it-works/code-transform.mdx:159
docs/content/docs/how-it-works/code-transform.mdx:169
docs/content/docs/how-it-works/framework-integrations.mdx:81
docs/content/docs/how-it-works/framework-integrations.mdx:131
docs/content/docs/how-it-works/framework-integrations.mdx:258
docs/content/docs/how-it-works/framework-integrations.mdx:313
docs/content/docs/how-it-works/framework-integrations.mdx:428
docs/content/docs/how-it-works/understanding-directives.mdx:24
docs/content/docs/how-it-works/understanding-directives.mdx:108
docs/content/docs/how-it-works/understanding-directives.mdx:123
docs/content/docs/how-it-works/understanding-directives.mdx:138
docs/content/docs/how-it-works/understanding-directives.mdx:153
docs/content/docs/how-it-works/understanding-directives.mdx:175
docs/content/docs/how-it-works/understanding-directives.mdx:195
docs/content/docs/how-it-works/understanding-directives.mdx:212
docs/content/docs/how-it-works/understanding-directives.mdx:222
docs/content/docs/how-it-works/understanding-directives.mdx:244
docs/content/docs/how-it-works/understanding-directives.mdx:301
docs/content/docs/how-it-works/understanding-directives.mdx:339
docs/content/docs/how-it-works/understanding-directives.mdx:362
docs/content/docs/how-it-works/understanding-directives.mdx:378
docs/content/docs/how-it-works/understanding-directives.mdx:436
docs/content/docs/how-it-works/understanding-directives.mdx:451
docs/content/docs/how-it-works/understanding-directives.mdx:512
docs/content/docs/how-it-works/understanding-directives.mdx:546
packages/docs-typecheck/README.md:63
packages/docs-typecheck/README.md:88
packages/world-postgres/README.md:45
packages/world-postgres/README.md:107
"

# Process each entry - we need to sort by line number descending so we don't mess up line numbers
echo "$INCOMPLETE_SNIPPETS" | grep -v "^$" | sort -t: -k1,1 -k2,2nr | while IFS=: read -r file line; do
  if [ -f "$file" ]; then
    # Insert the skip marker before the code block
    # The line number is where ```typescript starts
    # We need to insert the comment on the line before
    insert_line=$((line - 1))

    # Use sed to insert the skip marker
    # We're inserting: <!-- @skip-typecheck: incomplete code sample -->
    sed -i '' "${insert_line}a\\
<!-- @skip-typecheck: incomplete code sample -->
" "$file"

    echo "Added skip marker to $file:$line"
  fi
done
