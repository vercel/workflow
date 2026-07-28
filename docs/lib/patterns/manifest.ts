import {
  agentCancellationButtonSource,
  agentCancellationConceptHardCancelSource,
  agentCancellationConceptStopRouteSource,
  agentCancellationConceptStopSignalSource,
  agentCancellationRouteSource,
  agentCancellationStartRouteSource,
  agentCancellationUsageSource,
  agentCancellationWorkflowSource,
  agentCancellationWorkflowInstallSource,
} from './snippets/agent-cancellation';
import {
  aiSdkClientSource,
  aiSdkRouteSource,
  aiSdkWorkflowSource,
  aiSdkWorkflowInstallSource,
} from './snippets/ai-sdk';
import { batchingStartRouteSource } from './snippets/batching';
import {
  chatSdkBotSource,
  chatSdkHandlersSource,
  chatSdkWebhookSource,
  chatSdkWorkflowSource,
  chatSdkWorkflowInstallSource,
} from './snippets/chat-sdk';
import {
  childWorkflowsStartRouteSource,
  childWorkflowsUsageSource,
} from './snippets/child-workflows';
import {
  killSwitchButtonSource,
  killSwitchRouteSource,
  killSwitchUsageSource,
} from './snippets/kill-switch';
import { semaphoreUsageSource } from './snippets/semaphore';
import { rateLimiterUsageSource } from './snippets/rate-limiter';
import { circuitBreakerUsageSource } from './snippets/circuit-breaker';
import { debounceUsageSource } from './snippets/debounce';
import { batchAggregatorUsageSource } from './snippets/batch-aggregator';
import { singletonRunUsageSource } from './snippets/singleton-run';
import { pollingStartRouteSource } from './snippets/polling';
import { deadLetterQueueStartRouteSource } from './snippets/dead-letter-queue';
import { recurringCronStartRouteSource } from './snippets/recurring-cron';
import {
  stripeWorkflowSource,
  stripeWorkflowInstallSource,
  stripeWebhookRouteSource,
} from './snippets/stripe';
import {
  slackApprovalWorkflowSource,
  slackApprovalWorkflowInstallSource,
  slackApprovalRouteSource,
} from './snippets/slack-approval';
import {
  durableAgentClientSource,
  durableAgentStartRouteSource,
  durableAgentWorkflowSource,
  durableAgentWorkflowInstallSource,
} from './snippets/durable-agent';
import {
  humanInTheLoopCardSource,
  humanInTheLoopRouteSource,
  humanInTheLoopStartRouteSource,
  humanInTheLoopUsageSource,
  humanInTheLoopWorkflowSource,
  humanInTheLoopWorkflowInstallSource,
} from './snippets/human-in-the-loop';
import { idempotencyStartRouteSource } from './snippets/idempotency';
import {
  handlingRateLimitsStartRouteSource,
  handlingRateLimitsWorkflowSource,
  handlingRateLimitsWorkflowInstallSource,
} from './snippets/handling-rate-limits';
import {
  resendCancelRouteSource,
  resendStartRouteSource,
  resendUsageSource,
  resendWorkflowSource,
  resendWorkflowInstallSource,
} from './snippets/resend';
import { sagaStartRouteSource } from './snippets/saga';
import {
  sandboxClientSource,
  sandboxCommandRouteSource,
  sandboxStartRouteSource,
  sandboxUsageSource,
  sandboxPipelineInstallSource,
  sandboxWorkflowSource,
  sandboxWorkflowInstallSource,
} from './snippets/sandbox';
import {
  schedulingCancelRouteSource,
  schedulingStartRouteSource,
  schedulingUsageSource,
} from './snippets/scheduling';
import {
  sequentialAndParallelStartRouteSource,
  sequentialAndParallelWorkflowSource,
  sequentialAndParallelWorkflowInstallSource,
} from './snippets/sequential-and-parallel';
import { timeoutsStartRouteSource } from './snippets/timeouts';
import { webhooksStartRouteSource } from './snippets/webhooks';
import {
  workflowCompositionStartRouteSource,
  workflowCompositionWorkflowSource,
  workflowCompositionWorkflowInstallSource,
} from './snippets/workflow-composition';
import {
  upgradingWorkflowsResumeRouteSource,
  upgradingWorkflowsStartRouteSource,
  upgradingWorkflowsWorkflowSource,
  upgradingWorkflowsMethod2Source,
  upgradingWorkflowsMethod1InstallSource,
  upgradingWorkflowsMethod2InstallSource,
} from './snippets/upgrading-workflows';
import type {
  RegistryCategory,
  RegistryItem,
  RegistryPatternType,
} from './types';
import {
  batchAggregatorDisplaySource,
  batchAggregatorFullSource,
  batchingDisplaySource,
  batchingFullSource,
  childWorkflowsDisplaySource,
  childWorkflowsExampleDisplaySource,
  childWorkflowsExampleFullSource,
  childWorkflowsFullSource,
  circuitBreakerDisplaySource,
  circuitBreakerFullSource,
  deadLetterQueueDisplaySource,
  deadLetterQueueFullSource,
  debounceDisplaySource,
  debounceFullSource,
  idempotencyDisplaySource,
  idempotencyFullSource,
  killSwitchDisplaySource,
  killSwitchFullSource,
  pollingDisplaySource,
  pollingFullSource,
  rateLimiterDisplaySource,
  rateLimiterFullSource,
  recurringCronDisplaySource,
  recurringCronFullSource,
  sagaDisplaySource,
  sagaFullSource,
  schedulingDisplaySource,
  schedulingFullSource,
  semaphoreDisplaySource,
  semaphoreFullSource,
  singletonRunDisplaySource,
  singletonRunFullSource,
  timeoutsDisplaySource,
  timeoutsFullSource,
  webhooksEventListenerDisplaySource,
  webhooksEventListenerFullSource,
  webhooksRequestReplyDisplaySource,
  webhooksRequestReplyFullSource,
} from './generated';

/**
 * Public registry of installable Workflow patterns.
 *
 * Items are grouped by category in the order surfaced on the listing page —
 * Agents, Vercel, Common, Advanced, Providers — and alphabetised within each
 * group. Items can belong to more than one category (e.g. AI SDK is both an
 * `agent` pattern and a `vercel` integration); they appear once here, in
 * their primary group, and the listing page surfaces them under every
 * relevant filter.
 */
export const registryItems: RegistryItem[] = [
  {
    id: 'agent-cancellation',
    name: 'Agent Cancellation',
    logo: 'agent-cancellation',
    description:
      'Cancel a running AI agent gracefully — Stop button + workflow signal + hard-cancel fallback.',
    longDescription:
      'Cancel a running AI agent from the outside — for example, a Stop button in a chat UI, an admin cancellation endpoint, or a timeout fallback. Two patterns are available depending on whether you need the agent to exit cleanly or just need the run to stop: Hard Cancellation via `getRun(runId).cancel()` for immediate forced termination, or Stop Signal via a `stopHook` + `Promise.race` for a graceful exit that runs cleanup and streams a `data-stopped` part to the client so it renders a clean ending instead of an abrupt connection close. The stop route falls back to hard cancel automatically if the hook is already gone — so the Stop button always succeeds regardless of timing.',
    tags: ['agent', 'cancellation', 'stop-button', 'durable'],
    categories: ['agent'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    dependencies: ['@workflow/ai', 'ai', 'zod'],
    homepage: 'https://workflow-sdk.dev',
    docsUrl:
      'https://workflow-sdk.dev/cookbook/agent-patterns/agent-cancellation',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/agent-cancellation.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/agent-cancellation',
    envVars: [
      {
        name: 'AI_GATEWAY_API_KEY',
        description:
          'API key for Vercel AI Gateway. Lets you call any provider (Claude, GPT, Gemini, …) through one credential. Optional when running on Vercel with OIDC.',
        getKeyUrl: 'https://vercel.com/dashboard/ai-gateway',
        exampleValue: 'vck_********',
      },
    ],
    files: [
      {
        path: 'workflows/agent-cancellation-workflow.ts',
        description:
          'Durable agent + `stopHook` + `Promise.race` exit, with a final `data-stopped` part emitted on stop.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/agent-cancellation-workflow.ts',
        code: agentCancellationWorkflowSource,
        installCode: agentCancellationWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/agent/route.ts',
        code: agentCancellationStartRouteSource,
      },
      {
        label: 'Stop route',
        lang: 'tsx',
        caption: 'app/api/agent/[runId]/stop/route.ts',
        code: agentCancellationRouteSource,
      },
      {
        label: 'Button',
        lang: 'tsx',
        caption: 'components/stop-button.tsx',
        code: agentCancellationButtonSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Wire the Stop button into your chat UI',
        code: agentCancellationUsageSource,
      },
    ],
    conceptSnippets: [
      {
        label: 'Hard Cancel',
        lang: 'tsx',
        caption:
          'app/api/agent/[runId]/cancel/route.ts — one-liner forced termination',
        code: agentCancellationConceptHardCancelSource,
      },
      {
        label: 'Stop Signal',
        lang: 'tsx',
        caption:
          'workflows/agent-cancellation-workflow.ts — hook + Promise.race graceful exit',
        code: agentCancellationConceptStopSignalSource,
      },
      {
        label: 'Stop route',
        lang: 'tsx',
        caption: 'app/api/agent/[runId]/stop/route.ts',
        code: agentCancellationConceptStopRouteSource,
      },
    ],
    guide: {
      whenToUse: [
        '**Chat stop buttons** — let users cancel a long-running agent from the browser',
        '**Admin cancellation** — stop an agent from a different process or API endpoint',
        '**Timeout fallback** — combine with `sleep()` to auto-stop after a deadline',
        '**Hard Cancellation** — when the run is stuck or unresponsive and you just need it gone',
      ],
      approaches: {
        description:
          'Pick the option that matches what your endpoint needs to deliver to the caller:',
        bullets: [
          '**Hard Cancellation** — terminates the run immediately with no opportunity for cleanup or client notification. A single line of code, but the workflow throws `WorkflowRunCancelledError` and any streaming clients see an abrupt connection close.',
          '**Stop Signal** — the workflow exits as soon as the hook fires, runs any pending cleanup, emits a final `data-stopped` part to the stream so the client can render cleanly, and returns a real result.',
        ],
        columns: ['', 'Hard Cancellation', 'Stop Signal'],
        rows: [
          {
            aspect: 'Mechanism',
            values: ['`getRun(runId).cancel()`', 'Hook + `Promise.race`'],
          },
          {
            aspect: 'Speed to terminate',
            values: ['Immediate', 'At the next `await` boundary'],
          },
          {
            aspect: 'Runs `finally` / cleanup',
            values: ['No', 'Yes'],
          },
          {
            aspect: 'Final stream notification',
            values: ['No (abrupt close)', 'Yes (`data-stopped` part)'],
          },
          {
            aspect: '`run.returnValue`',
            values: [
              'Throws `WorkflowRunCancelledError`',
              "Returns the workflow's result",
            ],
          },
          {
            aspect: 'Code complexity',
            values: ['One line', 'Hook + race + signal step'],
          },
          {
            aspect: 'Best for',
            values: [
              'Stuck or unresponsive runs, forced termination',
              'User-facing stop, admin cancel, timeouts',
            ],
          },
        ],
      },
      approachSections: [
        {
          title: 'Hard Cancellation',
          description: 'Call `.cancel()` on a run to terminate it immediately:',
          snippetLabels: ['Hard Cancel'],
          afterBullets: [
            '**No cleanup runs** — `finally` blocks, defer-style step cleanup, and any logic after the current step are all skipped',
            '**No final notification to the client** — the writable closes abruptly, so a streaming UI just sees the connection drop with no `data-stopped` part to render a clean ending',
            '**`run.returnValue` throws** — anyone awaiting the result receives `WorkflowRunCancelledError` instead of a meaningful payload',
            '**Underlying step keeps running** — the model stream or HTTP call inside the current step continues to completion in the background',
          ],
          afterProse:
            'Hard Cancellation is the appropriate choice when the run is stuck or unresponsive, has exceeded its expected runtime, or you don\'t need a clean exit. For everything else — chat stop buttons, admin "stop" actions, timeout fallbacks — you typically want the Stop Signal pattern.',
        },
        {
          title: 'Stop Signal',
          description:
            'The workflow races the agent against a `stopHook` keyed by the run ID. When Stop is triggered, the workflow exits at its next `await` boundary, runs any cleanup, and emits a `data-stopped` stream part so the client renders a clean ending. The route falls back to hard cancel automatically if the hook is already gone.',
          installSlug: 'https://workflow-sdk.dev/r/agent-cancellation',
          snippetLabels: ['Stop Signal', 'Stop route'],
          callout: {
            type: 'warn',
            content:
              'Stop Signal does not cancel the underlying model stream. Tokens generated after the stop signal are still produced and billed by your provider. What it does is exit the workflow function and notify the client. For hard cross-process cancellation that signals the inner step to bail out, see the Distributed Abort Controller pattern.',
          },
        },
      ],
      howItWorks: [
        'A stopHook is created with token stop:${workflowRunId} when the workflow starts — the token is deterministic so any process can resume it given just the run ID.',
        'Promise.race runs the DurableAgent stream and the stop hook concurrently. The agent produces tokens normally until one of the two resolves.',
        'When your stop API calls stopHook.resume(runId, { reason }), the race resolves immediately to the stopped branch — the workflow exits at its next await boundary.',
        'Before returning, emitStopSignal writes a data-stopped part to the writable stream so the client knows the agent was stopped intentionally rather than disconnected.',
        'The stop route also falls back to getRun(runId).cancel() if the hook is already gone (e.g. the agent finished mid-request), so the Stop button always succeeds.',
      ],
      callout: {
        type: 'warn',
        content:
          'This pattern does not cancel the underlying model stream. Tokens generated after the stop signal are still produced and billed by your provider. What it does is exit the workflow function and notify the client. For hard cross-process cancellation that signals the inner step to bail out, see the Distributed Abort Controller pattern.',
      },
      adapting: [
        '**Add a timeout** — race a third `sleep()` promise to auto-stop after a deadline (e.g. 30 minutes).',
        '**Audit logging** — include a `reason` field in the stop schema to record who stopped the agent and why.',
        '**Cross-process** — the hook token is deterministic, so any server process can call `stopHook.resume()` with just the run ID.',
        '**Step limits** — combine with `maxSteps` on `DurableAgent` to cap execution even without a manual stop signal.',
        '**Multiple agents** — scope each `stopHook` to its own run ID so parallel agent chains never interfere.',
        '**Hard Cancellation as a fallback** — wire your stop endpoint to fall back to `getRun(runId).cancel()` if the hook resume errors with `not found` / `expired` (e.g. the hook was already consumed). This guarantees the run is terminated even when the Stop Signal path is unavailable.',
        "**Using WorkflowAgent instead** — the example uses `DurableAgent`, which is deprecated in favor of AI SDK's [`WorkflowAgent`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent); follow the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent). The stop mechanics (hook + `Promise.race` + hard-cancel fallback) are identical with either.",
      ],
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'getWorkflowMetadata()',
          url: '/docs/api-reference/workflow/get-workflow-metadata',
        },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
        {
          label: 'WorkflowAgent',
          url: 'https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent',
        },
        {
          label: 'getRun()',
          url: '/docs/api-reference/workflow-api/get-run',
        },
      ],
    },
  },
  {
    id: 'ai-sdk',
    name: 'AI SDK',
    logo: 'ai-sdk',
    description: 'Durable multi-turn chat with streaming and tools.',
    longDescription:
      '[AI SDK](https://ai-sdk.dev/) is Vercel\'s framework-agnostic TypeScript toolkit for building AI-powered apps and agents — unified provider access, streaming, tool calling, structured output, and UI hooks. Workflow SDK complements it by making the multi-turn loop durable: the conversation state, hooks, and per-turn responses survive restarts and timeouts. Note that in this pattern the durability boundary is the entire turn — individual tool calls inside a turn are **not** durable on their own (see Pitfalls below). For most agent use cases, prefer `DurableAgent`, which implements the same agent loop as `streamText`, manages tool calling automatically, and runs tools at workflow scope — each tool can be marked `"use step"` for per-call durability and retries. Use this pattern\'s raw `streamText()` approach when you want the exact AI SDK API or when the durability boundary should be an entire user turn.',
    tags: ['ai', 'chat', 'streaming', 'agents', 'durable'],
    categories: ['agent', 'vercel'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    dependencies: ['ai', 'zod'],
    homepage: 'https://ai-sdk.dev',
    docsUrl: 'https://ai-sdk.dev/docs',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/ai-sdk.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/ai-sdk',
    files: [
      {
        path: 'workflows/ai-sdk-workflow.ts',
        description:
          'The durable chat workflow — `supportWorkflow()` + `turnHook` + tool steps. One run = one full conversation.',
      },
      {
        path: 'app/api/support/route.ts',
        description:
          'POST endpoint that handles first-turn `start()` and follow-up `turnHook.resume()`, slicing per-turn streams from the durable log.',
      },
      {
        path: 'components/support-chat.tsx',
        description:
          '`useChat()` client component wired up via `WorkflowChatTransport` — forwards `runId` between turns automatically.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/ai-sdk-workflow.ts',
        code: aiSdkWorkflowSource,
        installCode: aiSdkWorkflowInstallSource,
      },
      {
        label: 'API route',
        lang: 'tsx',
        caption:
          'app/api/support/route.ts — handles first turn, follow-ups, and /done exit',
        description:
          'One endpoint handles first turn, follow-ups, and the `/done` exit. The client sends `runId` in the body to distinguish first vs follow-up.',
        code: aiSdkRouteSource,
      },
      {
        label: 'Client',
        lang: 'tsx',
        caption:
          'components/support-chat.tsx — stores runId in a ref, forwarded via WorkflowChatTransport',
        description:
          'Store the `runId` in a ref and pass it in the body of every follow-up. `WorkflowChatTransport` forwards it for you.',
        code: aiSdkClientSource,
      },
    ],
    guide: {
      flatLayout: true,
      callout: {
        type: 'info',
        content:
          'Because the conversation is one workflow run, it stays on the deployment that started it. If each turn should run on the latest deployment while preserving selected state or streams, see [Versioning](https://workflow-sdk.dev/docs/foundations/versioning) for the child-run continuation pattern.',
      },
      sourceDescription:
        'One workflow run = one full conversation. The workflow suspends between turns on a hook and resumes when the next user message arrives. Conversation state, tool history, and intermediate computation all live inside the run.',
      whenToUse: [
        '**The raw AI SDK API** — `streamText().toUIMessageStream()`, `onChunk`, `smoothStream`, or other options that map directly to the `streamText` return value rather than `DurableAgent.stream()`',
        '**Per-turn durability** — wrap the entire agent response (model + tools) in a single `"use step"` function so one user turn is the atomic retry unit; useful when you want all tool calls inside a turn to re-execute together',
        "**Custom multi-turn orchestration** — manual hook loops, per-turn stream slicing (`sliceUntilFinish`), or other workflow patterns that don't map cleanly to `DurableAgent`",
        '`DurableAgent` already supports `stopWhen`, `prepareStep`, `onStepFinish`, structured output (`experimental_output`), per-step model switching, and provider options — those are not reasons to drop down to raw `streamText`.',
      ],
      howItWorks: [
        '**One workflow = one conversation.** The workflow loops on a hook, keeping `allMessages`, tool history, and state alive across turns.',
        '**`runTurn` is the durability boundary.** Each turn is one step. The model request and all tool calls inside it run as plain inline functions within that step. If anything throws mid-turn, the whole `runTurn` retries — individual tool calls are not separately durable.',
        '**Hook is created once.** `turnHook.create({ token: workflowRunId })` outside the loop — calling it twice with the same token throws `HookConflictError`.',
        '**`preventClose: true`** on `pipeTo` keeps the durable writable open so the next turn can write to it.',
        '**`sliceUntilFinish`** in the API reads chunks until `type === "finish"`, then closes the HTTP response. The source reader is released — not cancelled — so the workflow stream keeps flowing.',
        '**`startIndex: tailIndex + 1`** gives each follow-up response only the new chunks, avoiding replay of previous turns.',
        '**`/done`** resumes the hook so the workflow exits cleanly, then returns a synthetic `start` + `finish` so `useChat` transitions out of "streaming".',
      ],
      approaches: {
        title: 'streamText vs DurableAgent',
        columns: ['', '`streamText()` (this pattern)', '`DurableAgent`'],
        rows: [
          {
            aspect: 'Tool loop',
            values: [
              'AI SDK handles via `stopWhen`',
              'Handles internally (AI SDK–compatible options)',
            ],
          },
          {
            aspect: 'LLM call durability',
            values: [
              'Re-executes with the parent turn',
              'Each LLM call is a durable step',
            ],
          },
          {
            aspect: 'Tool call durability',
            values: [
              'Not individually durable — re-executes with the parent turn',
              'Per tool — mark `"use step"` for a durable, retryable step, or keep at workflow level for `sleep()` / hooks',
            ],
          },
          {
            aspect: 'Stop conditions',
            values: ['`stopWhen`, `prepareStep`', '`stopWhen`, `prepareStep`'],
          },
          {
            aspect: 'Structured output',
            values: [
              '`Output.object()`, `Output.array()`',
              '`experimental_output` (`Output.object()`, `Output.text()`)',
            ],
          },
          {
            aspect: 'Step callbacks',
            values: [
              '`onStepFinish`, `onChunk`, etc.',
              '`onStepFinish`, `onFinish`, `onError`, `onAbort` (`onChunk` not available)',
            ],
          },
          {
            aspect: 'Setup',
            values: ['Manual stream piping and turn slicing', 'Automatic'],
          },
        ],
        closing:
          'Use `DurableAgent` for most agent use cases. Use `streamText` when you need the raw AI SDK surface or a per-turn durability boundary.',
      },
      adaptingIntro:
        'Non-obvious correctness details worth knowing before adapting this pattern.',
      adapting: [
        '**Tools are not individually durable** — `streamText()` calls each tool\'s `execute` inside the `runTurn` step, where a `"use step"` directive on the tool body is a no-op. The atomic retry unit is the entire turn: if `processRefund` succeeds and a later call throws, the whole turn retries and `processRefund` runs again. Make side-effectful tools idempotent (dedupe server-side on a stable key), or use `DurableAgent`, which runs tools at workflow scope so each can be its own durable step.',
        '**Snapshot `tailIndex` before resuming the hook** — reversing the order races the workflow: by the time you read `tailIndex`, the next turn may have already written its `start` chunk.',
        '**Don\'t call `writable.close()` inside a workflow function** — I/O operations must happen inside a `"use step"` function. When the workflow returns, the runtime closes the writable for you.',
        "**Don't use `TransformStream.terminate()` to slice the stream** — throws `Invalid state` when late-arriving chunks hit the transform. Use a manual `ReadableStream` pump as shown.",
        "**Release the source reader, don't cancel it** — use `reader.releaseLock()` in the `finally` block; `source.cancel()` propagates upstream and closes the durable writable, breaking the next turn.",
        '**Handle stale `runId` gracefully** — wrap the follow-up path in a try/catch for `not found` / `expired` and fall through to the first-turn path to start a fresh workflow.',
        '**`WorkflowChatTransport` moved to the AI SDK** — the version exported from `@workflow/ai` is deprecated. AI SDK ships a 1:1 port; use [`WorkflowChatTransport` from `@ai-sdk/workflow`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#resumable-streaming-with-workflowchattransport) for new code. The wiring shown here is identical with either import.',
      ],
      adaptingTitle: 'Pitfalls',
      keyApis: [
        {
          label: 'streamText()',
          url: 'https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text',
        },
        {
          label: 'tool() / tool calling',
          url: 'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling',
        },
        {
          label: 'stepCountIs() / stopWhen',
          url: 'https://ai-sdk.dev/docs/ai-sdk-core/agents#stop-conditions',
        },
        {
          label: 'convertToModelMessages()',
          url: 'https://ai-sdk.dev/docs/reference/ai-sdk-ui/convert-to-model-messages',
        },
        {
          label: 'createUIMessageStreamResponse()',
          url: 'https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream-response',
        },
        {
          label: 'useChat()',
          url: 'https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat',
        },
        {
          label: '"use step"',
          url: '/docs/foundations/workflows-and-steps#step-functions',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
        { label: 'getRun()', url: '/docs/api-reference/workflow-api/get-run' },
        {
          label: 'WorkflowChatTransport',
          url: '/docs/api-reference/workflow-ai/workflow-chat-transport',
        },
      ],
    },
  },
  {
    id: 'durable-agent',
    name: 'Durable Agent',
    logo: 'durable-agent',
    description:
      'Replace a stateless AI agent with a durable one — tools as steps, streamed output, crash-safe by default.',
    longDescription:
      "Use this pattern to make any AI SDK agent durable. The agent becomes a workflow, tools become steps, and the framework handles retries, streaming, and state persistence automatically. **`DurableAgent` is deprecated** — for new durable agent work, use AI SDK's [`WorkflowAgent`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent), which implements the same pattern from the AI SDK package, and follow the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent). This pattern remains accurate for existing `DurableAgent` code.",
    tags: ['agents', 'ai', 'durable', 'tools', 'streaming'],
    categories: ['agent'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    dependencies: ['@workflow/ai', 'ai', 'zod'],
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/durable-agent',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/durable-agent.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/durable-agent',
    files: [
      {
        path: 'workflows/durable-agent-workflow.ts',
        description:
          'The durable agent workflow — `flightAgent()` orchestrator + three tool steps (`searchFlights`, `bookFlight`, `checkWeather`). Replace the tools with your own.',
      },
      {
        path: 'app/api/flight-agent/route.ts',
        description:
          'POST endpoint that converts incoming `UIMessage`s, starts the agent with `start()`, and returns the streaming response with `x-workflow-run-id` set.',
      },
      {
        path: 'components/flight-agent-chat.tsx',
        description:
          '`useChat()` client component wired up via `WorkflowChatTransport` — forwards the run ID between turns automatically for durable multi-turn conversations.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/durable-agent-workflow.ts',
        code: durableAgentWorkflowSource,
        installCode: durableAgentWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/flight-agent/route.ts',
        code: durableAgentStartRouteSource,
      },
      {
        label: 'Client',
        lang: 'tsx',
        caption: 'components/flight-agent-chat.tsx',
        code: durableAgentClientSource,
      },
    ],
    guide: {
      flatLayout: true,
      callout: {
        type: 'warn',
        content:
          "`DurableAgent` is deprecated and remains documented for existing code only. Use AI SDK's `WorkflowAgent` for new durable agent work — it provides the same durability guarantees with a cleaner API, built-in tool approval flows, and resumable streaming, and lives in the AI SDK package. [View WorkflowAgent docs →](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent) See the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent), or the [`DurableAgent` API reference](https://workflow-sdk.dev/docs/api-reference/workflow-ai/durable-agent) while migrating.",
      },
      sourceDescription:
        'Replace `Agent` with `DurableAgent`, wrap the function in `"use workflow"`, mark each tool with `"use step"`, and stream output through `getWritable()`.',
      whenToUse: [
        '**Any AI agent with tool calls** that should survive crashes and restarts',
        '**Agents where tool calls hit external APIs** that need automatic retries',
        '**Long-running agent sessions** where losing progress is unacceptable',
        '**Agents that need per-step observability** in the workflow event log',
      ],
      howItWorks: [
        "**`DurableAgent` wraps `Agent`** — same API as AI SDK's `Agent`, but backed by a workflow. If the process crashes, the agent resumes from the last completed step on replay.",
        '**Tools as steps** — each tool\'s `execute` function uses `"use step"`, giving it automatic retries, full Node.js access, and an entry in the workflow event log.',
        "**Streaming** — `getWritable<UIMessageChunk>()` streams the agent's output (text chunks, tool calls, tool results) to the client in real time via `createUIMessageStreamResponse`.",
        '**`maxSteps`** — limits the total number of LLM calls the agent can make, preventing runaway tool loops.',
      ],
      adapting: [
        '**Change the model** — replace `"anthropic/claude-haiku-4.5"` with any AI Gateway model string (e.g. `"openai/gpt-4o"`, `"anthropic/claude-sonnet-4-5"`).',
        '**Add tools** — define a new `"use step"` function with a Zod schema. Each tool automatically gets retries and persistence.',
        '**Workflow-level tools** — if a tool needs workflow primitives like `sleep()` or `createHook()`, omit `"use step"` so it runs in the workflow context instead.',
        '**Multi-turn** — pass `result.messages` plus new user messages to subsequent `agent.stream()` calls for multi-turn conversations.',
        '**Client integration** — use `useChat()` from `@ai-sdk/react` with `WorkflowChatTransport` for a full chat UI with reconnection support. The `@workflow/ai` export is deprecated; prefer the 1:1 port in [`@ai-sdk/workflow`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#resumable-streaming-with-workflowchattransport).',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps#workflow-functions',
        },
        {
          label: '"use step"',
          url: '/docs/foundations/workflows-and-steps#step-functions',
        },
        {
          label: 'DurableAgent',
          url: '/docs/api-reference/workflow-ai/durable-agent',
        },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'human-in-the-loop',
    name: 'Human In The Loop',
    logo: 'human-in-the-loop',
    description:
      'Pause an AI agent to wait for human approval, then resume with the decision.',
    longDescription:
      'Use this pattern when an AI agent needs human confirmation before performing a consequential action like booking, purchasing, or publishing. The workflow suspends without consuming resources until the human responds.',
    tags: ['agent', 'approval', 'human-in-the-loop', 'durable'],
    categories: ['agent'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    dependencies: ['@workflow/ai', 'ai', 'zod'],
    homepage: 'https://workflow-sdk.dev',
    docsUrl:
      'https://workflow-sdk.dev/cookbook/agent-patterns/human-in-the-loop',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/human-in-the-loop.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/human-in-the-loop',
    files: [
      {
        path: 'workflows/human-in-the-loop-workflow.ts',
        description:
          'Durable agent + `approvalHook` + the `requestApproval` tool that races the hook against a 24h `sleep()` and streams resolution parts.',
      },
      {
        path: 'app/api/approval-agent/route.ts',
        description:
          'POST endpoint that starts the agent and returns the streaming response with `x-workflow-run-id` set.',
      },
      {
        path: 'app/api/approval/route.ts',
        description:
          'POST endpoint that resumes `approvalHook` with `{ approved, comment }`. Idempotent against expired/already-consumed hooks.',
      },
      {
        path: 'components/approval-card.tsx',
        description:
          'Reusable client component — renders the payload, posts the decision, and swaps to the resolution once it streams in.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/human-in-the-loop-workflow.ts',
        code: humanInTheLoopWorkflowSource,
        installCode: humanInTheLoopWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/approval-agent/route.ts',
        code: humanInTheLoopStartRouteSource,
      },
      {
        label: 'Approval route',
        lang: 'tsx',
        caption: 'app/api/approval/route.ts',
        description:
          'The approval route imports the hook definition and calls `.resume()` with the tool call ID as the token:',
        code: humanInTheLoopRouteSource,
      },
      {
        label: 'Card',
        lang: 'tsx',
        caption: 'components/approval-card.tsx',
        code: humanInTheLoopCardSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Wire the card into your chat UI',
        description:
          "Listen for `data-approval-needed` and `data-approval-resolved` custom data parts in the message stream. The approval tool invocation itself won't appear until the tool returns, so the custom data parts are the mechanism for showing and updating the approval UI.",
        code: humanInTheLoopUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      sourceDescription:
        'Create a typed hook using `defineHook()`. When the agent calls the approval tool, it emits a custom data part to the stream so the client can render approval controls, then creates a hook and suspends. An API route resumes the hook with the decision.',
      whenToUse: [
        '**Booking confirmations** where users must approve before charges are made',
        '**Content publishing gates** where an editor must sign off',
        '**Any agent action where the cost of getting it wrong** justifies a human check',
        '**Actions with side effects** that cannot be easily undone',
      ],
      howItWorks: [
        '**`defineHook()` with schema** — creates a typed hook with Zod validation. The approval payload is validated before the workflow receives it.',
        '**`toolCallId` as token** — the approval tool uses the tool call ID as the hook token, naturally linking the hook to the specific tool invocation.',
        "**`emitApprovalRequest` step** — writes a `data-approval-needed` custom data part to the stream *before* the hook suspends. Without this, the client would never see the approval controls because tool invocations don't stream until the tool returns.",
        '**No `"use step"` on the approval tool** — the tool runs at the workflow level because `defineHook().create()` is a workflow primitive. It calls step functions for I/O.',
        '**`Promise.race` with `sleep`** — the approval races against a durable timeout. If nobody responds, the workflow continues with an expiration message.',
        '**`emitApprovalResolved` step** — writes the outcome to the stream so the client can update the card immediately, without waiting for the tool-invocation result.',
      ],
      adapting: [
        '**Change the approval schema** — add fields like `reason`, `amount`, `reviewerEmail` to match your domain.',
        '**Multiple approval gates** — the pattern works for any number of tools. Each tool creates its own hook with its own `toolCallId`.',
        "**Escalation** — if the first approver doesn't respond, use `sleep()` + another hook to escalate to a backup reviewer.",
        '**Adjust timeout** — use `"24h"` for production, shorter durations for demos.',
        '**Workflow-level vs step tools** — tools that use `sleep()`, `defineHook()`, or other workflow primitives must NOT use `"use step"`. Tools with only I/O (API calls, DB queries) should use `"use step"` for retries.',
        "**Using WorkflowAgent instead** — the example uses `DurableAgent`, which is deprecated in favor of AI SDK's [`WorkflowAgent`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent); follow the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent). The approval-gate mechanics (hook + `sleep()` race inside a workflow-level tool) are identical with either.",
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps#workflow-functions',
        },
        {
          label: '"use step"',
          url: '/docs/foundations/workflows-and-steps#step-functions',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
        {
          label: 'WorkflowAgent',
          url: 'https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent',
        },
      ],
    },
  },
  {
    id: 'chat-sdk',
    name: 'Chat SDK',
    logo: 'chat-sdk',
    description: 'Durable bot sessions across Slack, Teams, Discord, and more.',
    longDescription:
      '[Chat SDK](https://chat-sdk.dev/) normalizes Slack, Microsoft Teams, Discord, Telegram, GitHub, Linear, and WhatsApp into one thread/message model. Workflow SDK complements it by making bot sessions durable — each conversation thread maps to one long-running workflow run that owns multi-turn state, can sleep for hours, and survives deploys and cold starts.',
    tags: ['chat', 'bots', 'slack', 'teams', 'discord', 'durable'],
    categories: ['vercel', 'agent'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    dependencies: [
      '@chat-adapter/slack',
      '@chat-adapter/state-redis',
      'chat',
      'zod',
    ],
    homepage: 'https://chat-sdk.dev',
    docsUrl: 'https://chat-sdk.dev/docs/guides/durable-chat-sessions-nextjs',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/chat-sdk.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/chat-sdk',
    files: [
      {
        path: 'lib/bot.ts',
        description:
          'The `Chat` singleton — adapters, state backend, and `ThreadState` type that holds the `runId` per thread.',
      },
      {
        path: 'workflows/chat-sdk-workflow.ts',
        description:
          'The durable session workflow — `durableChatSession()` + `chatTurnHook`, with platform side-effects in dynamic-import steps.',
      },
      {
        path: 'lib/chat-session-handlers.ts',
        description:
          'Event handlers — decide whether each inbound message is a `start()` or a `resumeHook()`, with stale-runId fallback.',
      },
      {
        path: 'app/api/webhooks/[platform]/route.ts',
        description:
          'Catch-all webhook route that hands every platform request to the right Chat SDK handler.',
      },
    ],
    snippets: [
      {
        label: 'Bot',
        lang: 'tsx',
        caption: 'lib/bot.ts',
        code: chatSdkBotSource,
      },
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/chat-sdk-workflow.ts',
        code: chatSdkWorkflowSource,
        installCode: chatSdkWorkflowInstallSource,
      },
      {
        label: 'Handlers',
        lang: 'tsx',
        caption: 'lib/chat-session-handlers.ts',
        code: chatSdkHandlersSource,
      },
      {
        label: 'Webhook route',
        lang: 'tsx',
        caption: 'app/api/webhooks/[platform]/route.ts',
        code: chatSdkWebhookSource,
      },
    ],
    guide: {
      flatLayout: true,
      introBullets: [
        'Owns multi-turn state in the durable event log instead of Redis-by-hand bookkeeping',
        'Can `sleep()` for hours or days waiting for a user reply, an approval, or a scheduled follow-up',
        'Survives deploys, cold starts, and crashes — the session picks up from the last step on replay',
        'Receives follow-up messages via hooks, so the bot stays responsive while the workflow is still running',
      ],
      diagram:
        'flowchart TD\n    A["Platform webhook"] --> B["Chat SDK event handler\\n(onNewMention, onSubscribedMessage, …)"]\n    B -->|"no runId in thread state"| C["start(durableChatSession, …)"]\n    B -->|"runId in thread state"| D["resumeHook(runId, { message })"]\n    C --> E["Workflow run (durable)\\none per thread — suspends between turns"]\n    D --> E\n    E --> F["use step helpers\\nthread.post(), thread.subscribe(), thread.setState(), …"]',
      diagramTitle: 'How it fits together',
      diagramContext: {
        prose:
          'Chat SDK owns the edge — webhook verification, event routing, `thread.post()` / `thread.stream()`. Workflow owns the session — state, loops, sleeps, retries. They meet at exactly two points:',
        bullets: [
          "**Inbound** — Chat SDK handlers decide whether to `start(workflow, [thread, message])` or `resumeHook(runId, { message })`. The `runId` lives in Chat SDK's thread state (Redis, Postgres, or any state adapter).",
          '**Outbound** — the workflow calls Chat SDK APIs (`thread.post()`, `thread.subscribe()`, `thread.setState()`) from inside step functions only — never from the top level of a workflow file, as adapter packages use Node-only modules not available in the workflow sandbox.',
        ],
      },
      whySection: {
        title: 'Why Workflow + Chat SDK',
        problemProse:
          'Without Workflow, a long-running bot session usually means one of:',
        problemBullets: [
          "Holding a webhook request open while the agent runs (doesn't survive restarts, blows past platform timeouts)",
          'Writing session state to Redis manually, plus a scheduler for timeouts and retries, plus custom reconnection logic',
        ],
        solutionProse:
          'Workflow replaces all of that with a single durable function. The bot can:',
        solutionBullets: [
          'Run a tool loop for minutes while the user watches typing indicators',
          'Wait for a human approval in another thread before continuing',
          'Schedule a follow-up message 24 hours later via `sleep("24h")`',
          'Pause on sandbox snapshot, resume when the user sends the next command',
        ],
        closingProse:
          'Because the session is a workflow run, its history is recoverable from the event log — no separate message store to keep in sync.',
      },
      whenToUse: [
        '**Run a tool loop for minutes** while the user watches typing indicators, without holding the webhook open',
        '**Wait for human approval** in another thread before continuing — `Promise.race([hook, approvalHook])`',
        '**Schedule a follow-up** message hours or days later via `sleep("24h")`',
        '**Multi-turn state** without Redis-by-hand bookkeeping, custom schedulers, or reconnection logic',
        '**Any bot session** that must survive deploys, cold starts, and crashes mid-turn',
      ],
      howItWorks: [
        "**Thread state stores the `runId`.** Chat SDK's state adapter (Redis, Postgres, memory) holds `{ runId }` per thread — the only piece of glue between the two SDKs.",
        '**First mention → `start()`.** The handler serializes `thread` + `message` with `toJSON()`, passes them to `start(durableChatSession, [payload])`, and stashes the returned `runId` in thread state.',
        "**Subsequent messages → `resumeHook()`.** The handler looks up the `runId`, serializes the new message, and resumes the workflow's hook. The workflow picks up on the next `await hook` iteration.",
        '**Workflow posts back via steps.** All Chat SDK side-effects (`thread.post`, `thread.subscribe`, `thread.setState`) run inside `"use step"` helpers that dynamically import the bot — keeping adapter packages outside the workflow sandbox.',
        '**Session ends two ways.** The workflow returns normally (user said `done`, approval granted) or throws. Either way the run completes; the next inbound message with the stale `runId` falls through to `startSession()`.',
      ],
      howItWorksClosing:
        'The workflow is fully durable between turns: `await hook` suspends with zero compute cost, and platform webhooks can fire from anywhere without concern for which server instance handled the previous turn.',
      adapting: [
        '**Stream AI SDK responses** — use the AI SDK integration inside a step, then pass `result.fullStream` to `thread.post()` for platform-native streaming (Slack edit-in-place, Telegram message-per-chunk).',
        '**Give the bot a sandbox** — combine with the Sandbox integration: each thread gets its own persistent sandbox session, snapshots on idle, resumes on the next message.',
        '**Human-in-the-loop approvals** — `Promise.race([hook, approvalHook])` inside the workflow, post buttons via cards, resume `approvalHook` from `bot.onAction()`.',
        '**Scheduled follow-ups** — `sleep("24h")` before a proactive check-in. Surviving restarts is free.',
        '**Don\'t import the bot at the top of workflow files** — keep `import { bot }` inside `"use step"` functions with `await import(...)`. Adapter packages use Node-only modules not available in the workflow sandbox.',
        '**Always call `registerSingleton()`** — Chat SDK rehydrates `Thread` objects inside step functions via `reviver` and needs the singleton to resolve adapters and state. Without it, thread methods throw from step contexts.',
        '**Hook payloads must be JSON-serializable** — `Message` and `Thread` have methods; pass them through `.toJSON()` / `Message.fromJSON()` across hook boundaries. Define `ChatTurnPayload` in its own file so both the webhook handler and the workflow sandbox can import it without dragging in adapter code.',
        "**Handle stale `runId`s** — gate on `getRun(runId).exists` before calling `resumeHook`, or catch `not found` / `expired` and fall through to `startSession`. Never drop the user's message.",
        '**Keep the hook outside the loop** — one `chatTurnHook.create({ token: workflowRunId })` per workflow run, reused every iteration. Creating with the same token throws `HookConflictError`.',
        '**Platform timeouts are separate from workflow timeouts** — Slack wants a 200 within 3 seconds. Return immediately after `resumeHook` (which is fast); the workflow runs in the background and posts back via `thread.post`. Never `await` the whole turn inside the webhook handler.',
      ],
      adaptingTitle: 'Extending the pattern',
      keyApis: [
        {
          label: 'Chat / Thread / Message',
          url: 'https://chat-sdk.dev/docs/api/chat',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'getRun()', url: '/docs/api-reference/workflow-api/get-run' },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'registerSingleton()',
          url: 'https://chat-sdk.dev/docs/api/chat',
        },
      ],
    },
  },
  {
    id: 'sandbox',
    name: 'Vercel Sandbox',
    logo: 'sandbox',
    description: 'Persistent code-execution session beyond the 5-hour cap.',
    longDescription:
      'The [`@vercel/sandbox`](https://vercel.com/docs/vercel-sandbox) package has first-class support for the Workflow SDK — the `Sandbox` class is serializable, and its methods (`create`, `runCommand`, `stop`, `snapshot`) implicitly run as steps, so you can use `Sandbox` directly inside a workflow function without wrapping each call in `"use step"`. Wrapping the sandbox in a workflow run gives you a durable controller for its entire lifetime: auto-hibernation on idle, proactive rollover before the 5-hour sandbox hard cap, and reconnection by a single `runId` — so one logical session can run effectively forever on top of time-bounded infrastructure.',
    tags: ['sandbox', 'agents', 'sessions', 'durable', 'snapshots'],
    categories: ['vercel', 'agent'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    dependencies: ['@vercel/sandbox', 'zod'],
    homepage: 'https://vercel.com/docs/vercel-sandbox',
    docsUrl: 'https://vercel.com/docs/vercel-sandbox',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/sandbox.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/sandbox',
    files: [
      {
        path: 'workflows/sandbox-session-workflow.ts',
        description:
          'The durable session workflow — `sandboxSessionWorkflow()` + `commandHook`, with idle hibernation and proactive sandbox refresh built in.',
      },
      {
        path: 'workflows/sandbox-pipeline-workflow.ts',
        description:
          'Pipeline variant — run a fixed command sequence in a sandbox and tear it down, no interactive session.',
      },
      {
        path: 'app/api/sandbox/start/route.ts',
        description:
          'POST endpoint that starts a new session or reconnects to an existing one, replaying the durable event log to a returning client.',
      },
      {
        path: 'app/api/sandbox/command/route.ts',
        description:
          'POST endpoint that resumes the command hook — every shell command the user runs flows through here.',
      },
      {
        path: 'components/sandbox-runner.tsx',
        description:
          'Client component that streams NDJSON events from `/start`, auto-reconnects from `localStorage` on mount, and sends commands to `/command`.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/sandbox-session-workflow.ts',
        code: sandboxWorkflowSource,
        installCode: sandboxWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/sandbox/start/route.ts',
        description:
          'Two endpoints. `/start` accepts an optional `{ runId }` — if the run still exists, it replays the event log from index 0 so a returning client fully rehydrates. `/command` resumes the hook and returns immediately; command output lands on the `/start` stream.',
        code: sandboxStartRouteSource,
      },
      {
        label: 'Command route',
        lang: 'tsx',
        caption: 'app/api/sandbox/command/route.ts',
        code: sandboxCommandRouteSource,
      },
      {
        label: 'Client',
        lang: 'tsx',
        caption: 'components/sandbox-runner.tsx',
        description:
          'On mount, if a `runId` is stashed in `localStorage`, reconnect to the existing run. Otherwise start fresh. Commands are POSTed to `/command` — output lands on the `/start` stream.',
        code: sandboxClientSource,
      },
      {
        label: 'Quickstart',
        lang: 'tsx',
        caption: 'workflows/sandbox-pipeline-workflow.ts',
        description:
          'Before the full session pattern, the simplest shape. Each `Sandbox` method is an implicit step, so the event log records every command and the workflow replays from the last completed call on restart.',
        code: sandboxUsageSource,
        installCode: sandboxPipelineInstallSource,
      },
    ],
    guide: {
      flatLayout: true,
      whySection: {
        title: 'Why Workflow + Sandbox',
        solutionProse:
          "A sandbox alone gets you an isolated VM. A workflow around it gets you a durable controller for that VM's entire lifetime:",
        solutionBullets: [
          "**One workflow run = one sandbox session.** The `runId` is the only state you need to persist on the client. Close the tab, come back a week later, POST the same `runId` and you're back in the same session.",
          '**Efficient resource use.** Active sandboxes cost money; hibernated workflows cost nothing. The workflow races a command hook against a `sleep()` timer — when idle, it calls `sandbox.snapshot()` (which also stops the VM) and waits indefinitely.',
          '**Beyond the 5-hour hard cap.** The workflow tracks the sandbox deadline and proactively snapshots + recreates before the cap, so the logical session outlives any one VM.',
          '**Automatic cleanup.** `try/finally` in the workflow guarantees the VM is stopped on failure or destroy.',
        ],
      },
      whenToUse: [
        '**Coding agents** — spawn agents that run "infinitely in the cloud": full filesystem, network, and runtime, with auto-hibernation when the user walks away and instant reconnect when they return',
        '**AI dev environments** — long-running sessions where users send tasks, go idle, and come back days later expecting the same branch, filesystem, and git history',
        '**Any workload that outlives a 5-hour sandbox** — the pattern rolls over the hard cap automatically; the logical session has no deadline of its own',
        '**Interactive pipelines** — wherever you need real-time streaming of stdout/stderr to a client while the sandbox runs multi-step jobs',
      ],
      sourceDescription:
        "One workflow run owns a sandbox for its whole lifetime. The workflow's loop does two jobs simultaneously — a command pipeline (await a hook, run the user command, stream output, repeat) and a sandbox lifecycle manager (race the hook against a `sleep()` timer armed for the earlier of the idle deadline or the refresh deadline). When the timer wins: if idle, `sandbox.snapshot()` and wait indefinitely; if near the hard cap, snapshot and immediately create a new sandbox from that snapshot. The only way out is an explicit `/destroy` command.",
      howItWorks: [
        '**One workflow = one session.** The workflow owns a sandbox for its entire lifetime. The `runId` is the only state the client has to remember.',
        '**Hook created once.** `commandHook.create({ token: workflowRunId })` outside the loop — creating it twice with the same token throws `HookConflictError`.',
        '**Two timer branches.** The active-state race wakes on the earlier of `idleDeadline` and `refreshDeadline`. The hibernated state awaits the hook alone — no timer, no compute.',
        '**Proactive refresh.** `refreshDeadline = sandboxExpiresAt - REFRESH_SAFETY_MS`. Hitting this triggers a snapshot + immediate new sandbox from that snapshot, rolling over the hard cap without user intervention.',
        "**`sandbox.snapshot()` stops the VM.** It's part of the snapshot process — don't call `stop()` separately.",
        '**Resume = new sandbox.** `Sandbox.create({ source: { type: "snapshot", snapshotId } })` creates a fresh VM. The new sandbox has a different `sandboxId`; filesystem, installed packages, and git history are preserved.',
        '**Reconnect by runId.** `getRun(runId).getReadable({ startIndex: 0 })` replays the durable event log to a returning client, who rebuilds UI state from the replay.',
        "**Exit only on `/destroy`.** The workflow loop has no hard deadline of its own. Individual sandboxes time out; the session doesn't.",
      ],
      adapting: [
        '**`sandbox.stop()` is terminal** — a stopped sandbox cannot be restarted. Hibernation is only possible via `snapshot()` + new-sandbox-from-snapshot. Don\'t "pause" an active sandbox with `stop()` and resume later.',
        '**`snapshot()` already stops the VM** — calling `stop()` after `snapshot()` either errors or is a no-op. The snapshot takes care of it.',
        '**New `sandboxId` after resume and refresh** — both `resuming` (idle → command) and `refreshing` (near-hard-cap rotation) create a new sandbox with a new `sandboxId`. Emit it on the subsequent `status: "active"` event; don\'t rely on the initial `created` event.',
        '**Keep the refresh margin generous** — `snapshot()` + `Sandbox.create({ source })` takes real time (typically tens of seconds). If `REFRESH_SAFETY_MS` is too small the old sandbox hits its hard cap mid-snapshot. Leave at least 60–90 seconds; 5 minutes is comfortable.',
        '**Don\'t call `writable.close()` inside a workflow function** — stream closure must happen inside a `"use step"` function. The runtime closes the underlying writable when the workflow returns.',
        '**Handle stale `runId` gracefully** — gate the reconnect path on `run.exists` and fall through to starting fresh. On `hook.resume`, catch `not found` / `expired` and return 410 so the client clears its state.',
        '**Keep the hook outside the loop** — creating a new hook per iteration with the same token throws `HookConflictError`. One hook, one token (`workflowRunId`), reused every iteration.',
      ],
      adaptingTitle: 'Pitfalls',
      adaptingIntro:
        'Non-obvious correctness details worth knowing before adapting this pattern.',
      keyApis: [
        {
          label: 'Sandbox.create',
          url: 'https://vercel.com/docs/vercel-sandbox/sdk-reference',
        },
        {
          label: 'sandbox.runCommand',
          url: 'https://vercel.com/docs/vercel-sandbox/sdk-reference',
        },
        {
          label: 'sandbox.snapshot',
          url: 'https://vercel.com/docs/vercel-sandbox/sdk-reference',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        { label: 'getRun()', url: '/docs/api-reference/workflow-api/get-run' },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
      ],
    },
  },
  {
    id: 'batching',
    name: 'Batching',
    logo: 'batching',
    description:
      'Process large collections in parallel batches with failure isolation between groups.',
    longDescription:
      "Use batching when you need to process a large list of items in parallel while controlling concurrency. Items are split into fixed-size batches, each batch runs concurrently, and failures in one batch don't affect others.",
    tags: ['batching', 'fan-out', 'parallel', 'bulk-import'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/batching',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/batching.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/batching',
    files: [
      {
        path: 'workflows/batching-workflow.ts',
        description:
          'Generic `batchImport()` — chunks records, runs each batch with Promise.allSettled, paces with sleep(), returns a tally + failure list.',
      },
      {
        path: 'app/api/batching/route.ts',
        description: 'POST endpoint that starts the batch import workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/batching-workflow.ts',
        description:
          'The workflow splits records into chunks, processes each chunk concurrently, tracks results per batch, and returns a final tally. Each record runs in its own `"use step"` function with full Node.js access and automatic retries.',
        code: batchingDisplaySource,
        installCode: batchingFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/batching/route.ts',
        code: batchingStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Bulk data imports — contacts, orders, products from a CSV or database',
        'Processing hundreds or thousands of items against external APIs',
        'Calling rate-limited APIs where you need to control concurrency',
        'Any fan-out where you want failure isolation between groups',
      ],
      howItWorks: [
        'Records are split into fixed-size batches.',
        "Each batch runs in parallel via `Promise.allSettled` — failures in one record don't affect others.",
        'A `sleep()` between batches paces requests to avoid overloading downstream services.',
        'After all batches, a summary is returned with succeeded/failed counts.',
      ],
      adapting: [
        '**Change the `Record` type** — replace `ImportRecord` with your actual data shape (orders, images, products, etc.).',
        '**Replace `processRecord()`** — swap in your real import logic: DB upserts, API calls, file processing.',
        '**Tune `batchSize` and `sleep()`** — match the values to your downstream rate limits.',
        "**Add or remove tracking** — the pattern works with any item type; strip the failure list if you don't need per-record reasons.",
        '**`Promise.allSettled` over `Promise.all`** — `Promise.all` rejects on the first failure; `allSettled` waits for everything and tells you what failed. Use it whenever you want to continue even if some items fail.',
        "**Tune batch size to your API's concurrency limit** — if the API allows 10 concurrent requests, use `batchSize: 10`.",
        '**`sleep()` is durable** — the pacing delay between batches survives cold starts and process restarts.',
        '**Each `processRecord` call is an independent step** — if one fails it retries up to 3× without affecting other items in the batch.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'Promise.allSettled()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled',
        },
      ],
    },
  },
  {
    id: 'idempotency',
    name: 'Idempotency',
    logo: 'idempotency',
    description:
      "Pass each step's deterministic stepId as the Idempotency-Key so retries never duplicate side effects.",
    longDescription:
      "Workflow steps can be retried (on failure) and replayed (on cold start). If a step calls an external API that isn't idempotent, retries could create duplicate charges, send duplicate emails, or double-process records. Use idempotency keys to make these operations safe.",
    tags: ['idempotency', 'stripe', 'retries', 'exactly-once'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/idempotency',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/idempotency.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/idempotency',
    envVars: [
      {
        name: 'STRIPE_SECRET_KEY',
        description:
          'Stripe API secret key — the example charges via Stripe with an idempotency key.',
        getKeyUrl: 'https://dashboard.stripe.com/apikeys',
        exampleValue: 'sk_live_********',
      },
    ],
    files: [
      {
        path: 'workflows/idempotency-workflow.ts',
        description:
          '`chargeCustomer()` workflow — Stripe charge + receipt, both keyed by their step IDs so retries dedupe automatically.',
      },
      {
        path: 'app/api/idempotency/route.ts',
        description: 'POST endpoint that starts the charge workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/idempotency-workflow.ts',
        code: idempotencyDisplaySource,
        installCode: idempotencyFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/idempotency/route.ts',
        code: idempotencyStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Charging a payment (Stripe, PayPal)',
        'Sending transactional emails or SMS',
        'Creating records in external systems where duplicates are harmful',
        "Any step that has side effects in systems you don't control",
      ],
      sourceDescription:
        'Every step has a unique, deterministic `stepId` available via `getStepMetadata()`. Pass this as the `Idempotency-Key` header to external APIs — Stripe and most external systems that support the convention will deduplicate requests keyed by this ID.',
      adapting: [
        "**`stepId` is deterministic** — it's the same value across retries and replays of the same step, making it a reliable idempotency key.",
        "**Always provide idempotency keys for non-idempotent external calls** — even if you think a step won't be retried, cold-start replay will re-execute it.",
        '**Handle 409/conflict as success** — if an external API returns "already processed," treat that as a successful result, not an error.',
        '**Make your own APIs idempotent** — accept an idempotency key and return the cached result on duplicate requests.',
        '**Rely on the external API\'s idempotency, not local flags** — Workflow doesn\'t provide distributed locking. Check-then-act patterns ("read a flag, then write if not set") race between concurrent runs.',
        "**Don't use check-then-act patterns** — another run could read the same flag between your read and write. Use a unique constraint or the external API's deduplication layer instead.",
      ],
      adaptingTitle: 'Tips & caveats',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps#workflow-functions',
        },
        {
          label: '"use step"',
          url: '/docs/foundations/workflows-and-steps#step-functions',
        },
        {
          label: 'getStepMetadata()',
          url: '/docs/api-reference/workflow/get-step-metadata',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'handling-rate-limits',
    name: 'Handling Rate Limits',
    logo: 'handling-rate-limits',
    description:
      'Handle 429 responses and transient failures with RetryableError + automatic backoff.',
    longDescription:
      'Use this pattern when calling external APIs that enforce rate limits. Instead of writing manual retry loops, throw `RetryableError` with a `retryAfter` value and let the workflow runtime handle rescheduling — more efficient than wall-clock sleeps and survives cold starts. To bound your own outbound request rate proactively (rather than reacting to 429s), see the Rate Limiter component.',
    tags: ['rate-limit', 'retry', 'backoff', '429'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/handling-rate-limits',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/handling-rate-limits.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/handling-rate-limits',
    files: [
      {
        path: 'workflows/handling-rate-limits-workflow.ts',
        description:
          '`syncContact()` — Retry-After header on 429, exponential backoff on 5xx, `maxRetries = 10` override for known-flaky endpoints.',
      },
      {
        path: 'app/api/handling-rate-limits/route.ts',
        description: 'POST endpoint that starts the rate-limited sync.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/handling-rate-limits-workflow.ts',
        code: handlingRateLimitsWorkflowSource,
        installCode: handlingRateLimitsWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/handling-rate-limits/route.ts',
        code: handlingRateLimitsStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Calling APIs that return 429 (Too Many Requests) with `Retry-After` headers',
        'Any step that hits transient failures and needs backoff',
        'Syncing data with third-party services (Stripe, CRMs, scrapers)',
      ],
      sourceDescription:
        'A step function calls an external API. On 429, it reads the `Retry-After` header and throws `RetryableError` — the runtime reschedules the step after the specified delay. For transient 5xx failures, use `getStepMetadata().attempt` to calculate exponential backoff (`1s, 4s, 9s…`). Set `fn.maxRetries` on the step function to override the default retry count of 3.',
      adapting: [
        '**`RetryableError` is for transient failures** — use it when the request might succeed on a later attempt (429, 503, network timeout).',
        "**`FatalError` is for permanent failures** — use it when retrying won't help (404, 401, invalid input). This skips all remaining retries immediately.",
        '**`retryAfter` accepts millis, duration strings, or a `Date`** — pass `parseInt(retryAfter) * 1000`, `"1m"`, `"30s"`, or `new Date(...)`.',
        '**Steps retry up to 3 times by default** — set `fn.maxRetries = N` on any step function to override the retry count per endpoint.',
        "**Don't write manual sleep-retry loops** — `RetryableError` is more efficient and survives cold starts; the runtime handles scheduling natively.",
        '**Circuit breaker** — when a dependency is completely down, use `sleep()` for a durable cooldown period, then probe with a single test request.',
        '**Application-level retry** — for custom retry conditions or when building libraries, wrap step calls with your own backoff utility rather than `RetryableError`.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        {
          label: 'RetryableError',
          url: '/docs/api-reference/workflow/retryable-error',
        },
        {
          label: 'FatalError',
          url: '/docs/api-reference/workflow/fatal-error',
        },
        {
          label: 'getStepMetadata()',
          url: '/docs/api-reference/workflow/get-step-metadata',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
      ],
    },
  },
  {
    id: 'saga',
    name: 'Saga',
    logo: 'saga',
    description:
      'Multi-step business transactions with automatic rollback on failure.',
    longDescription:
      'Use the saga pattern when a business transaction spans multiple services and you need automatic rollback if any step fails. Each forward step registers a compensation, and on failure the workflow unwinds them in reverse order.',
    tags: ['saga', 'transactions', 'rollback', 'compensation'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/saga',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/saga.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/saga',
    files: [
      {
        path: 'workflows/saga-workflow.ts',
        description:
          'Subscription-upgrade saga — three forward steps, three matching idempotent compensations, LIFO unwind on FatalError.',
      },
      {
        path: 'app/api/saga/route.ts',
        description: 'POST endpoint that starts the saga workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/saga-workflow.ts',
        code: sagaDisplaySource,
        installCode: sagaFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/saga/route.ts',
        code: sagaStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Multi-service transactions — reserve inventory, charge payment, provision access',
        'Any sequence where partial completion leaves the system in an inconsistent state',
        'Operations that need "all or nothing" semantics across external APIs',
      ],
      howItWorks: [
        'Each forward step does work and registers a compensation function.',
        'If any step throws `FatalError`, the catch block runs compensations in reverse (LIFO) order to restore consistency.',
        "Regular errors are retried automatically (up to 3× by default). Use `FatalError` only for permanent failures where retrying won't help.",
      ],
      sourceDescription:
        'Each step returns a result and pushes a compensation handler onto a stack. If a later step throws a `FatalError`, the workflow catches it and executes compensations in LIFO order.',
      adapting: [
        '**Replace step functions with real API calls** — each `"use step"` function has full Node.js access.',
        '**Add or remove steps freely** — the pattern scales to any number of forward + compensation pairs.',
        '**Make compensations idempotent** — they may be retried if the workflow restarts mid-rollback. Check whether the resource was already released before releasing it again.',
        '**Compensation steps are also `"use step"` functions** — this makes them durable; if the workflow restarts mid-rollback, it resumes where it left off.',
        "**Use `FatalError` for permanent failures** — regular errors trigger automatic retries (up to 3×). Throw `FatalError` when retrying won't help (insufficient funds, invalid input, etc.).",
        '**Capture values in closures carefully** — use block-scoped variables or copy values before pushing compensations to avoid referencing stale state.',
        "**Notifications don't need compensations** — fire-and-forget steps like sending emails or Slack messages typically don't register a compensation.",
        '**The `getStepMetadata()` dedupe is optional** — the example uses `stepId` to keep the demo ledger append-once under at-least-once retries. Drop it if your steps are already idempotent.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps#workflow-functions',
        },
        {
          label: '"use step"',
          url: '/docs/foundations/workflows-and-steps#step-functions',
        },
        {
          label: 'FatalError',
          url: '/docs/api-reference/workflow/fatal-error',
        },
        {
          label: 'getStepMetadata()',
          url: '/docs/api-reference/workflow/get-step-metadata',
        },
      ],
    },
  },
  {
    id: 'scheduling',
    name: 'Scheduling',
    logo: 'scheduling',
    description:
      'Schedule any future action with durable sleep and a cancel hook — no DB flags required.',
    longDescription:
      "Workflow's `sleep()` is durable — it survives cold starts, restarts, and deployments. Combined with `defineHook()` and `Promise.race()`, it becomes the foundation for interruptible scheduled workflows like drip campaigns, reminders, and timed sequences.",
    tags: ['scheduling', 'reminders', 'cancellable', 'sleep'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/scheduling',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/scheduling.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/scheduling',
    files: [
      {
        path: 'workflows/scheduling-workflow.ts',
        description:
          '`scheduleAction()` workflow + exported `cancelSchedule` hook + `runAction` step you customise per use case.',
      },
      {
        path: 'app/api/scheduling/route.ts',
        description: 'POST endpoint that schedules a new action.',
      },
      {
        path: 'app/api/scheduling/cancel/route.ts',
        description:
          'POST endpoint that cancels an in-flight schedule by token. Idempotent — safe to call when the schedule has already fired.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/scheduling-workflow.ts',
        code: schedulingDisplaySource,
        installCode: schedulingFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Defer, cancel, and cancellableSleep in your own workflows',
        code: schedulingUsageSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/scheduling/route.ts',
        code: schedulingStartRouteSource,
      },
      {
        label: 'Cancel route',
        lang: 'tsx',
        caption: 'app/api/scheduling/cancel/route.ts',
        description:
          'Any server-side code can fire the hook by calling `.resume()` with the same token — if no active schedule is found, the error is caught and treated as success.',
        code: schedulingCancelRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Sending emails on a schedule (drip campaigns, onboarding sequences, reminders)',
        'Waiting for a deadline but allowing early cancellation',
        'Any pattern where "do X, wait N hours, then do Y" needs to be both reliable and interruptible',
      ],
      sourceDescription:
        'The reusable core is `cancellableSleep(token, delay)` — a durable sleep raced against a cancel hook, callable from any workflow. `scheduleAction()` builds the one-shot scheduler on top of it: defer `runAction` until the delay elapses, unless something resumes the cancel hook first.',
      howItWorks: [
        '**Durable sleep** — `sleep("2d")` persists through restarts at zero compute cost. The workflow resumes precisely when the timer fires.',
        '**Hook creation** — `cancelSchedule.create({ token })` registers a hook that resolves when any external system calls `.resume()` with the same token.',
        '**Race** — `cancellableSleep()` wraps `Promise.race([sleep(...), hook])`: it resolves `"elapsed"` when the timer fires or `"cancelled"` when the hook is resumed first.',
        '**Semantic tokens** — the hook token is `schedule:<your-id>`, so cancelling needs only the ID you chose at schedule time, not the run ID.',
      ],
      adapting: [
        '**Change durations** — replace `"2d"` with any duration string (`"1h"`, `"7d"`, `"30m"`) or a `Date` object for absolute times.',
        '**Add more steps** — the pattern scales to any number of email-then-sleep pairs.',
        '**Snooze instead of cancel** — resolve the hook with a `snooze` payload and sleep again: `sleep(new Date(Date.now() + payload.snoozeMs))`.',
        '**Timeout any operation** — the same `Promise.race(sleep, work)` pattern works for adding deadlines to slow steps.',
        '**Real providers** — swap the `sendEmail` step body for Resend, Postmark, or any HTTP API. The `"use step"` function has full Node.js access.',
        '**`sleep()` accepts duration strings, millis, or `Date` objects** — `"1d"`, `"2h"`, `"30s"`, a millisecond number, or `new Date(...)` for an absolute time.',
        '**Durable means durable** — a `sleep("7d")` workflow costs nothing while sleeping — no compute, no memory.',
        '**Use `sleep()` in workflow context only** — step functions cannot call `sleep()` directly. If a step needs a delay, use `setTimeout` inside the step.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'Promise.race()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race',
        },
      ],
    },
  },
  {
    id: 'sequential-and-parallel',
    name: 'Sequential & Parallel',
    installable: false,
    logo: 'sequential-and-parallel',
    description:
      'Compose steps with await, Promise.all, and Promise.race against durable sleeps and webhooks.',
    longDescription:
      "Workflows are written in plain async/await — there's no new control-flow API to learn. Sequential awaits chain steps that depend on each other, `Promise.all` runs independent steps in parallel, and `Promise.race` returns whichever finishes first. These compose with workflow primitives like `sleep()` and `createWebhook()` since those are also just promises.",
    tags: ['composition', 'parallel', 'race', 'pipeline'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    homepage: 'https://workflow-sdk.dev',
    docsUrl:
      'https://workflow-sdk.dev/cookbook/common-patterns/sequential-and-parallel',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/sequential-and-parallel.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/sequential-and-parallel',
    files: [
      {
        path: 'workflows/sequential-and-parallel-workflow.ts',
        description:
          'Three entry points — pipeline, fan-out, race — over a small set of placeholder steps you replace with real work.',
      },
      {
        path: 'app/api/sequential-and-parallel/route.ts',
        description: 'POST endpoint that starts the fan-out workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/sequential-and-parallel-workflow.ts',
        code: sequentialAndParallelWorkflowSource,
        installCode: sequentialAndParallelWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/sequential-and-parallel/route.ts',
        code: sequentialAndParallelStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        "**Pipelines** — each step depends on the previous step's output (validate → process → store)",
        "**Independent fan-out** — fetch multiple resources or perform multiple actions that don't depend on each other",
        '**Race conditions** — return as soon as one of N operations completes (timeout, first-responder, deadline)',
        '**Mixing primitives** — running steps, sleeps, and webhooks side-by-side in the same control-flow expression',
      ],
      sourceDescription:
        'The workflow file ships three entry points — a sequential pipeline, a parallel fan-out with `Promise.all`, and a race against a deadline with `Promise.race`. Most real workflows combine all three.',
      howItWorks: [
        "**`await` is durable** — when the workflow awaits a step, the runtime persists the step's input, suspends the workflow, runs the step, and replays the workflow with the result on resume. The same applies to `sleep()` and `createWebhook()`.",
        '**`Promise.all` runs steps concurrently** — each promise in the array is suspended on its own and the workflow resumes only when all have settled. Failures propagate — if any promise rejects, the whole `Promise.all` rejects.',
        '**`Promise.race` resolves on the first settle** — the losing promises keep running in the background but their results are discarded by the workflow.',
        '**All primitives are promises** — `sleep("1 day")` and `createWebhook()` return promises, so they compose with `Promise.all` / `Promise.race` exactly like steps do — this is what makes "race a webhook against a 24-hour deadline" a one-liner.',
      ],
      adapting: [
        "**Replace `Promise.all` with `Promise.allSettled`** when partial failures should not abort the rest. You'll get an array of `{ status, value | reason }` instead of throwing on the first rejection.",
        "**Bound the parallelism** — `Promise.all` over 1000 items will fan out 1000 concurrent steps. If downstream APIs can't handle that, split the array into fixed-size chunks (see the Batching pattern).",
        '**Add a deadline to any race** — pair the operation with `sleep("30s").then(() => "timeout" as const)` and check the discriminated result. See the Timeouts pattern for full examples.',
        '**Mix steps and hooks in a race** — wait for an external signal, a deadline, or a step result all in the same `Promise.race`. The first one to resolve wins.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'createWebhook()',
          url: '/docs/api-reference/workflow/create-webhook',
        },
        {
          label: 'Promise.all()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all',
        },
        {
          label: 'Promise.race()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race',
        },
        {
          label: 'Promise.allSettled()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled',
        },
      ],
    },
  },
  {
    id: 'timeouts',
    name: 'Timeouts',
    logo: 'timeouts',
    description:
      'Add deadlines to slow steps, hooks, and webhooks by racing them against durable sleep.',
    longDescription:
      'A common requirement is bounding how long a workflow waits for something to finish — a slow step, an external webhook, a human approval. Race the operation against a durable `sleep()` with `Promise.race()` — whichever finishes first wins, and the loser keeps running but its result is ignored.',
    tags: ['timeout', 'deadline', 'race', 'sleep'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/timeouts',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/timeouts.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/timeouts',
    files: [
      {
        path: 'workflows/timeouts-workflow.ts',
        description:
          'Three entry points — hard timeout, soft timeout with fallback, and a webhook racing a 7-day deadline.',
      },
      {
        path: 'app/api/timeouts/route.ts',
        description: 'POST endpoint that starts the hard-timeout workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/timeouts-workflow.ts',
        code: timeoutsDisplaySource,
        installCode: timeoutsFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/timeouts/route.ts',
        code: timeoutsStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Slow steps** — bound the time spent waiting on third-party APIs, model calls, or expensive computation',
        "**External callbacks** — give webhooks a deadline so the workflow doesn't hang forever waiting for an event that may never arrive",
        "**Human approvals** — auto-decline or escalate when a hook isn't resumed within a window",
        '**Polling loops** — give an outer poll-until-ready loop an overall budget',
      ],
      sourceDescription:
        'Two entry points are included — a hard timeout on a slow step (throws when the deadline fires) and a timeout on an external webhook callback with a 7-day deadline.',
      howItWorks: [
        '**Durable sleep** — `sleep("30s")` persists through restarts at zero compute cost. The workflow resumes precisely when the timer fires.',
        '**Race** — `Promise.race([work, sleep(...)])` returns the value of whichever promise resolves first. The loser keeps running in the background but its result is ignored by the workflow.',
        '**Discriminated result** — tagging the sleep branch with a sentinel value (`"timeout" as const`, `{ timedOut: true }`) lets TypeScript narrow the result and pick the right branch.',
        '**Throw to fail the workflow** — inside a workflow function, throwing an `Error` exits the run with that error. Use `FatalError` inside steps; throw plain errors inside workflows.',
      ],
      callout: {
        type: 'warn',
        content:
          "**The losing operation keeps running.** `Promise.race` doesn't cancel — when the sleep wins, the underlying step (or model call, or HTTP request) continues to completion in the background. This is fine for idempotent reads but matters when the operation has side effects or costs money.",
      },
      adapting: [
        '**Different durations** — `sleep()` accepts duration strings (`"30s"`, `"5m"`, `"7 days"`), milliseconds, or `Date` objects for absolute deadlines.',
        '**Soft timeout (retry)** — instead of throwing, loop and retry with a fresh `Promise.race` and a backoff.',
        '**Soft timeout (fallback)** — return a default value when the timer wins instead of throwing: `if (result === "timeout") return cachedFallback`.',
        '**Combine with cancellation** — race three promises: the operation, a deadline `sleep()`, and a cancellation hook. See the Scheduling pattern for the cancellation half of this.',
        '**Per-step deadlines** — wrap each step in its own `Promise.race` for independent budgets, or use a single outer race for an overall workflow deadline.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'createWebhook()',
          url: '/docs/api-reference/workflow/create-webhook',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'Promise.race()',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race',
        },
      ],
    },
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    logo: 'webhooks',
    description:
      'Receive HTTP callbacks from external services, process them durably, and respond inline.',
    longDescription:
      'Use webhooks when external services push events to your application via HTTP callbacks. The workflow creates a webhook URL, suspends with zero compute cost, and resumes when a request arrives.',
    tags: ['webhook', 'callback', 'integration', 'external-api'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/webhooks',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/webhooks.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/webhooks',
    files: [
      {
        path: 'workflows/webhooks-event-listener-workflow.ts',
        description:
          '`paymentWebhook()` — long-running event ledger that processes multiple requests from one URL and exits on a terminal event.',
      },
      {
        path: 'workflows/webhooks-request-reply-workflow.ts',
        description:
          '`asyncVerification()` — submits a request with your webhook URL as callback and races the response against a deadline.',
      },
      {
        path: 'app/api/webhooks/route.ts',
        description:
          'POST endpoint that starts the payment webhook. The auto-generated webhook URL is exposed via `webhook.url` in the workflow return value.',
      },
    ],
    snippets: [
      {
        label: 'Event listener',
        lang: 'tsx',
        caption: 'workflows/webhooks-event-listener-workflow.ts',
        description:
          'Long-running listener that processes multiple requests from one URL and exits on a terminal event — Stripe-style payment ledger.',
        code: webhooksEventListenerDisplaySource,
        installCode: webhooksEventListenerFullSource,
      },
      {
        label: 'Request-reply',
        lang: 'tsx',
        caption: 'workflows/webhooks-request-reply-workflow.ts',
        description:
          'Submit a request to an external vendor with your webhook URL as the callback, then race the response against a 30-second deadline.',
        code: webhooksRequestReplyDisplaySource,
        installCode: webhooksRequestReplyFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/webhooks/route.ts',
        code: webhooksStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        'Accepting callbacks from payment processors (Stripe, PayPal)',
        'Waiting for third-party verification or processing results',
        'Any integration where an external system calls you back asynchronously',
      ],
      sourceDescription:
        'Two patterns are included — choose the one that fits your integration. Both use `createWebhook({ respondWith: "manual" })` to get a URL you pass to the external service.',
      adapting: [
        '**`respondWith: "manual"`** gives you control over the HTTP response from inside a step. Use this when you need to validate the request before responding.',
        '**`for await` on a webhook** lets you process multiple events from the same URL. Use `break` to stop listening after a terminal event.',
        '**Webhooks auto-generate URLs** at `/.well-known/workflow/v1/webhook/:token`. Pass this URL to external services.',
        "**Race webhooks against `sleep()`** for deadlines. If the callback doesn't arrive in time, the workflow can take a fallback action.",
        '**For large payloads**, use a hook + reference token instead of passing the data through the workflow. The event log serializes all step inputs/outputs, so large payloads hurt performance.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        {
          label: 'createWebhook()',
          url: '/docs/api-reference/workflow/create-webhook',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'FatalError',
          url: '/docs/api-reference/workflow/fatal-error',
        },
      ],
    },
  },
  {
    id: 'workflow-composition',
    name: 'Workflow Composition',
    installable: false,
    logo: 'workflow-composition',
    description:
      'Call workflows from workflows — direct await for inline composition, start() for independent runs.',
    longDescription:
      "Workflows can call other workflows. Choose between two composition modes depending on whether the parent needs the child's result inline (direct await) or wants to fire the child off as an independent run (background spawn). For massive fan-out with hook-based waiting and partial-failure handling, see the Child Workflows pattern.",
    tags: ['composition', 'child-workflow', 'spawn', 'start'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    homepage: 'https://workflow-sdk.dev',
    docsUrl:
      'https://workflow-sdk.dev/cookbook/common-patterns/workflow-composition',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/workflow-composition.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/workflow-composition',
    files: [
      {
        path: 'workflows/workflow-composition-workflow.ts',
        description:
          'Parent + child workflows demonstrating both direct-await flattening and background spawn via `start()` from a step.',
      },
      {
        path: 'app/api/workflow-composition/route.ts',
        description: 'POST endpoint that starts the parent workflow.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/workflow-composition-workflow.ts',
        code: workflowCompositionWorkflowSource,
        installCode: workflowCompositionWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/workflow-composition/route.ts',
        code: workflowCompositionStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        "**Direct await** — the parent needs the child's result before continuing, and you want a single unified event log",
        "**Background spawn** — the parent doesn't need to wait, and you want the child to be observable as a separate run with its own `runId`",
      ],
      sourceDescription:
        'Both composition modes are in a single workflow file — the direct-await child is called inline from the parent, while the background-spawn pattern wraps `start()` inside a `"use step"` function to keep it deterministic across replays.',
      howItWorks: [
        "**Direct await flattens** — when a workflow function awaits another workflow function, the child's steps emit into the parent's event log and share the parent's run ID.",
        '**`start()` mints a new run** — the child gets its own `runId`, its own event log, and its own retry boundary. The parent only sees the `runId` returned by `start()`.',
        '**`start()` must be called from a step** — wrap it in a `"use step"` function. This keeps the spawn deterministic across replays.',
      ],
      callout: {
        type: 'info',
        content:
          'To run the child workflow on the latest deployment rather than the current one, pass `deploymentId: "latest"` in the `start()` options. This is a Vercel-specific feature. The child\'s function name, file path, argument types, and return type must remain compatible across deployments — renaming the function or changing its location will change the workflow ID.',
      },
      approaches: {
        title: 'Choosing between the two modes',
        columns: ['', 'Direct await', 'Background spawn (`start()`)'],
        rows: [
          { aspect: 'Parent waits for child', values: ['Yes', 'No'] },
          {
            aspect: 'Has its own `runId`',
            values: ["No (shares parent's)", 'Yes'],
          },
          { aspect: 'Has its own event log', values: ['No', 'Yes'] },
          { aspect: 'Has its own retry boundary', values: ['No', 'Yes'] },
          {
            aspect: 'Best for',
            values: [
              'Sequential composition, helper workflows',
              'Independent work, fire-and-forget, fan-out',
            ],
          },
        ],
      },
      adapting: [
        '**Spawn many children at once** — call `start()` in a loop inside a step. For more advanced fan-out (chunking, polling, partial-failure handling), see the Child Workflows pattern.',
        '**Wait for a background child to finish** — combine `start()` with `getRun()` polling. The Child Workflows pattern covers the full polling loop.',
        '**Pass results back from background children** — the spawn step returns the `runId`; later, a poll step uses `getRun(runId).returnValue` to fetch the final result.',
      ],
      adaptingTitle: 'Adapting to your use case',
      keyApis: [
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        { label: 'getRun()', url: '/docs/api-reference/workflow-api/get-run' },
      ],
    },
  },
  {
    id: 'child-workflows',
    name: 'Child Workflows',
    logo: 'child-workflows',
    description:
      'Spawn many independent child workflows from a parent and wait for completion via hook resume.',
    longDescription:
      "Use child workflows when a single workflow needs to orchestrate many independent units of work. Each child runs as its own workflow with a separate event log, retry boundary, and failure scope — if one child fails, it doesn't take down the parent or siblings. Instead of polling `getRun().status` in a sleep loop, each child resumes a completion hook on the parent when it finishes — zero compute while waiting, immediate wake-up, and a typed result payload.",
    tags: ['fan-out', 'spawn', 'hooks', 'orchestration'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    dependencies: ['zod'],
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/child-workflows',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/child-workflows.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/child-workflows',
    files: [
      {
        path: 'workflows/child-workflows.ts',
        description:
          'The reusable component — completion hook + `withChildCompletionHook()` + `startAndWait()`. Import these for any parent/child pair; no changes needed.',
      },
      {
        path: 'workflows/child-workflows-example.ts',
        description:
          'Worked example — `processDocumentBatch()` parent + `processDocument()` child + spawn step wired up with the component.',
      },
      {
        path: 'app/api/child-workflows/route.ts',
        description:
          'POST endpoint that starts the parent workflow with a list of document IDs.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/child-workflows.ts',
        description:
          'The generic machinery — import `startAndWait()` and `withChildCompletionHook()` from here for any parent/child pair.',
        code: childWorkflowsDisplaySource,
        installCode: childWorkflowsFullSource,
      },
      {
        label: 'Example',
        lang: 'tsx',
        caption: 'workflows/child-workflows-example.ts',
        description:
          'A worked example — document batch processing wired up with the component.',
        code: childWorkflowsExampleDisplaySource,
        installCode: childWorkflowsExampleFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Spawn children and await typed results from any workflow',
        code: childWorkflowsUsageSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/child-workflows/route.ts',
        code: childWorkflowsStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Work units are independent** — each child can run without knowing about the others (e.g., processing individual documents, generating separate reports)',
        '**You need isolated failure boundaries** — a failing child should not abort unrelated work; the parent decides how to handle failures',
        '**You want massive fan-out** — spawning 50 or 500 children is practical because each runs on its own infrastructure',
        '**You need per-item observability** — each child workflow has its own run ID, status, and event log for monitoring',
      ],
      sourceDescription:
        'Two files install: `workflows/child-workflows.ts` is the reusable component (completion hook, `withChildCompletionHook()`, `startAndWait()`) — import it unchanged for any parent/child pair. `workflows/child-workflows-example.ts` is a worked example: a child workflow (`processDocument`), a wrapped child export that reports its outcome, a spawn step, and a parent (`processDocumentBatch`) that fans out with `Promise.all`.',
      howItWorks: [
        '**Completion hook** — the parent creates a hook per child (stable token from parent `runId` + child key) and suspends on it. Zero compute while waiting, immediate wake-up when the child finishes.',
        "**Wrapped child export** — runs the real child in try/catch/finally and resumes the parent's hook with `{ status, value | error }` from a step in `finally`, so the parent always wakes up, even on failure.",
        '**Spawn step** — `start()` is called from inside a `"use step"` function (in v5 it can also be called directly from the workflow), passing the hook token to the wrapped child.',
        '**`startAndWait()`** — ties hook creation, spawning, and the typed result together: it throws on `{ status: "failed" }` and returns the child\'s value otherwise.',
      ],
      adapting: [
        '**Why hooks instead of polling `getRun().status`** — zero compute while waiting, immediate wake-up instead of waiting for the next poll tick, typed payloads (no separate `returnValue` fetch step), and no worker-pool pressure from polling inside steps.',
        "**`defineHook().resume()` must be called from a step.** The wrapped child's `finally` block calls a step that resumes the parent hook.",
        '**Export wrapped children at module scope.** The SDK registers `"use workflow"` functions statically — a runtime higher-order function cannot be passed to `start()`.',
        "**Use stable hook keys** — document ID, job ID, or index — so parallel children inside one parent run don't collide on tokens.",
        '**Tolerate partial failures** — use `Promise.allSettled` with `startAndWait()` so one failing child doesn\'t abort siblings. The hook payload already carries `{ status: "failed", error }`.',
        '**Retry failed children** — spawn a replacement with a fresh hook key (e.g. `` `${documentId}:${attempt}` ``) and cap attempts to prevent infinite loops.',
        '**Use chunked spawning for large batches** — starting 500 children at once creates a large burst of work. Break it into chunks of 10–50.',
        '**Use `deploymentId: "latest"`** if children should run on the most recent deployment. Function name, file path, and argument types must remain compatible across deployments.',
        "**Spawns are at-least-once** — if the spawn step crashes after `start()` succeeds, its retry starts a second child. Both report completion (the parent consumes one), but the duplicate's side effects still run — keep child work idempotent. A keyed/atomic `start()` (see workflow#2376) will make spawns exactly-once.",
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        {
          label: 'getWorkflowMetadata()',
          url: '/docs/api-reference/workflow/get-workflow-metadata',
        },
        {
          label: '"use workflow"',
          url: '/docs/foundations/workflows-and-steps',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
      ],
    },
  },
  {
    id: 'kill-switch',
    name: 'Kill Switch',
    logo: 'kill-switch',
    description:
      'Named, durable cancellation flag that works across processes and machines — trip it anywhere, observe it everywhere.',
    longDescription:
      "Use this pattern when you need a cancellation flag that works across distributed systems. A `KillSwitch` is identified by a semantic ID (not a runId) — calling `.abort()` on one machine fires the `.signal` `AbortSignal` on any other machine that created a switch with the same ID. Workflow v5 ships native `AbortController`/`AbortSignal` support *within* a run (see the Cancellation docs); a kill switch is the cross-process, cross-run complement: a named durable flag backed by a coordination workflow, with TTL auto-expiry and a grace period for late subscribers. Because `.signal` is a real `AbortSignal`, it plugs into `fetch` and anything else AbortSignal-aware — including v5's native cancellation support.",
    tags: ['kill-switch', 'cancellation', 'distributed', 'cross-process'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/kill-switch',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/kill-switch.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/kill-switch',
    files: [
      {
        path: 'workflows/kill-switch-workflow.ts',
        description:
          'Coordination workflow + `KillSwitch` class with `.abort()` and `.signal` (an `AbortSignal`).',
      },
      {
        path: 'app/api/abort/[id]/route.ts',
        description:
          'POST endpoint that triggers the abort signal for a given semantic ID. Idempotent.',
      },
      {
        path: 'components/cancel-button.tsx',
        description:
          'Client component — calls the abort route on click and reflects the cancellation state in the UI.',
      },
    ],
    snippets: [
      {
        label: 'Lib',
        lang: 'tsx',
        caption: 'workflows/kill-switch-workflow.ts',
        code: killSwitchDisplaySource,
        installCode: killSwitchFullSource,
      },
      {
        label: 'Abort route',
        lang: 'tsx',
        caption: 'app/api/abort/[id]/route.ts',
        code: killSwitchRouteSource,
      },
      {
        label: 'Cancel button',
        lang: 'tsx',
        caption: 'components/cancel-button.tsx',
        code: killSwitchButtonSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Pass `controller.signal` to any AbortSignal-aware API',
        code: killSwitchUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Cross-process cancellation** — cancel a long-running operation from a different server, worker, or edge function',
        '**Durable cancellation** — the abort signal persists even if the process that created it crashes',
        '**UI stop buttons** — let users cancel operations running on the server from the browser',
        '**Timeout coordination** — the built-in TTL auto-expires stale controllers',
      ],
      sourceDescription:
        'The lib module ships the `DistributedAbortController` class plus the backing workflow. The abort route handles remote cancellation via a POST endpoint. The cancel button is a ready-to-use client component.',
      howItWorks: [
        '**Semantic ID** — `create()` accepts a meaningful ID (e.g. `"chat:123"`) and either starts a new coordination workflow or reconnects to an existing one via `getHookByToken()`.',
        "**Race** — the workflow races a `defineHook` abort signal against a `sleep()` TTL expiration. Whichever fires first writes a cancellation message to the run's stream.",
        '**`.signal` streams** — `getRun(runId).getReadable()` reads the stream and flips a local `AbortController` when the abort message arrives, returning a standard `AbortSignal`.',
        '**Grace period** — on TTL expiration (not manual abort), the workflow sleeps through an additional grace period to allow late subscribers to receive the signal before the run closes.',
      ],
      adapting: [
        '**Use semantic IDs** — use meaningful IDs like `chat:123` or `task:abc` instead of random UUIDs so any process can reconnect without sharing a run ID.',
        '**`create()` is idempotent** — calling `create()` with the same ID reconnects to the existing controller; no duplicate workflows are created.',
        '**TTL auto-cleanup** — workflows self-terminate after TTL expires; no manual cleanup needed. Adjust `ttlMs` per use case (default: 24 hours).',
        '**`.signal` is a getter** — each access to `.signal` creates a new stream reader and `AbortController`; cache the result if you need to reuse it.',
        '**One-shot** — once aborted or expired, the workflow completes. Create a new controller for new operations.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'getWritable()',
          url: '/docs/api-reference/workflow/get-writable',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        {
          label: 'getHookByToken()',
          url: '/docs/api-reference/workflow-api/get-hook-by-token',
        },
        { label: 'getRun()', url: '/docs/api-reference/workflow-api/get-run' },
      ],
    },
  },
  {
    id: 'semaphore',
    name: 'Semaphore',
    logo: 'semaphore',
    description:
      'At most N concurrent executions of a critical section — across all runs and machines. Includes withLock() mutex.',
    longDescription:
      'A distributed semaphore backed by a coordination workflow. `withPermit(key, max, fn)` suspends until one of `max` permits is free — across every workflow run, deployment, and machine — runs `fn`, and releases on the way out (including on failure). `withLock(key, fn)` is the single-permit mutex special case. Waiters cost zero compute while queued, grants are FIFO, and the whole thing self-heals: senders lazily restart the coordinator and waiters re-request if a grant goes missing.',
    tags: ['semaphore', 'mutex', 'lock', 'concurrency', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/semaphore',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/semaphore.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/semaphore',
    files: [
      {
        path: 'workflows/semaphore-workflow.ts',
        description:
          'The complete component — coordinator workflow + `withPermit()` / `withLock()` consumer API. Import and call; nothing to adapt.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/semaphore-workflow.ts',
        code: semaphoreDisplaySource,
        installCode: semaphoreFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Call withPermit() / withLock() from any workflow function',
        code: semaphoreUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Bounding concurrency against a shared resource** — "at most 3 concurrent syncs to this API" across every run of every workflow',
        '**Mutual exclusion** — one migration / one writer per tenant at a time, cluster-wide (`withLock`)',
        '**Fan-out wider than one parent** — `Promise.all` bounds concurrency within a run; a semaphore bounds it across runs',
      ],
      sourceDescription:
        'One file ships the whole component: a per-key coordinator workflow that owns the permit count and reads a single acquire/release event channel, plus the `withPermit()` / `withLock()` consumer API. You import the consumers; the coordinator starts lazily on first use.',
      howItWorks: [
        '**Single event channel** — acquires and releases flow through one hook read by one consumer (the coordinator), so ordering is FIFO and no message is lost to racing readers.',
        '**Grant via reply hook** — each waiter creates a fresh hook, sends its token with the acquire, and suspends. The coordinator resumes that token when capacity frees up. Zero compute while waiting.',
        '**Lazy start, safe recycle** — senders start the coordinator if resuming fails; the coordinator exits after enough grants once fully idle (`inFlight === 0`, queue empty), keeping its event log bounded.',
        "**Self-healing waiters** — if a grant doesn't arrive within `ACQUIRE_RETRY_TIMEOUT` (e.g. the coordinator recycled), the waiter disposes its stale hook (so a late grant can't leak capacity) and re-requests.",
      ],
      adapting: [
        '**Call from workflow functions only** — `withPermit()` creates hooks and uses durable sleep, which are workflow-context primitives.',
        '**Keep `maxConcurrent` consistent per key** — the value used by whichever caller starts the coordinator wins. Bake key + limit pairs into one module to avoid drift.',
        '**Size `ACQUIRE_RETRY_TIMEOUT` above your longest hold** — waiters that time out rejoin the queue, so too-small values cause churn, not deadlock.',
        '**Permits are not leases** — a crashed holder releases via its workflow retry/finally semantics, not via expiry. For lease-style timeouts, wrap `fn` in a timeout (see the Timeouts pattern) so the `finally` release always runs.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'createHook()',
          url: '/docs/api-reference/workflow/create-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
      ],
    },
  },
  {
    id: 'rate-limiter',
    name: 'Rate Limiter',
    logo: 'rate-limiter',
    description:
      'Bound your outbound request rate to an API — cluster-wide, with queued waiters and zero infrastructure.',
    longDescription:
      'A proactive, distributed rate limiter. `withRateLimit(key, intervalMs, fn)` waits for a request slot, then runs `fn` — and slots are granted at most once per `intervalMs` across every workflow run and machine (100ms → max 10 req/s cluster-wide). Requests queue in arrival order at zero compute cost. This complements the Handling Rate Limits pattern: that one reacts to 429s with `RetryableError`; this one keeps you from hitting the limit in the first place. They compose well — limit proactively, and still handle the occasional 429 reactively.',
    tags: ['rate-limit', 'throttle', 'concurrency', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/rate-limiter',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/rate-limiter.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/rate-limiter',
    files: [
      {
        path: 'workflows/rate-limiter-workflow.ts',
        description:
          'The complete component — coordinator workflow + `withRateLimit()` consumer API.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/rate-limiter-workflow.ts',
        code: rateLimiterDisplaySource,
        installCode: rateLimiterFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Call withRateLimit() from any workflow function',
        code: rateLimiterUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**A vendor caps you at N requests/second** and many concurrent runs all call it — smooth the traffic instead of triggering 429s',
        '**Protecting your own services** from workflow-driven thundering herds',
        '**Fairness across runs** — slots are granted in arrival order, so one greedy run cannot starve the others',
      ],
      sourceDescription:
        'One file ships the whole component: a per-key coordinator that grants one slot, sleeps `intervalMs`, then grants the next — plus the `withRateLimit()` consumer API. Queued requests buffer in the hook channel, so the spacing between grants IS the rate limit.',
      howItWorks: [
        "**Grant-then-sleep** — the coordinator loop awaits the next request, grants it via the waiter's reply hook, then sleeps `intervalMs`. Maximum cluster-wide rate = `1000 / intervalMs` per second.",
        '**Backpressure for free** — requests queue in the hook channel in arrival order; waiters suspend at zero compute until granted.',
        '**Dead-waiter skip** — a waiter that timed out disposes its reply hook; granting it fails and the coordinator moves on WITHOUT burning the interval sleep on it.',
        '**Lazy start, bounded log** — senders restart the coordinator on demand; it recycles after `RECYCLE_AFTER_GRANTS`. Dropped queue entries self-heal via waiter retry.',
      ],
      adapting: [
        '**Call from workflow functions only** — `withRateLimit()` creates hooks and uses durable sleep.',
        '**Smooth vs burst** — this is a fixed-spacing limiter. For burst allowances (e.g. 100/min in any shape), track a token count in the coordinator and only sleep when it hits zero.',
        '**Size `SLOT_RETRY_TIMEOUT` to worst-case queue depth × interval** — timed-out waiters re-request and rejoin the back of the queue.',
        '**Compose with Handling Rate Limits** — keep throwing `RetryableError` on 429 inside `fn`; the limiter makes those rare rather than redundant.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'createHook()',
          url: '/docs/api-reference/workflow/create-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
      ],
    },
  },
  {
    id: 'circuit-breaker',
    name: 'Circuit Breaker',
    logo: 'circuit-breaker',
    description:
      'Stop hammering a failing dependency — closed/open/half-open state shared across every run.',
    longDescription:
      'A distributed circuit breaker backed by a coordination workflow. `withBreaker(key, fn)` asks "may I proceed?" before calling the dependency: while the circuit is open the call is rejected instantly with `CircuitOpenError`; after a cooldown a single half-open probe decides whether to close it again. Because the state machine lives in one durable run, failures observed by ANY workflow protect EVERY workflow that shares the key. The cooldown arrives as a timer message from a tiny child workflow, so the coordinator answers checks instantly in every state.',
    tags: ['circuit-breaker', 'resilience', 'failure', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/circuit-breaker',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/circuit-breaker.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/circuit-breaker',
    files: [
      {
        path: 'workflows/circuit-breaker-workflow.ts',
        description:
          'The complete component — breaker state machine workflow, cooldown timer child, and the `withBreaker()` consumer API.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/circuit-breaker-workflow.ts',
        code: circuitBreakerDisplaySource,
        installCode: circuitBreakerFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Wrap dependency calls in withBreaker() from any workflow',
        code: circuitBreakerUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**A downstream service is melting** and hundreds of concurrent runs retrying independently would make it worse',
        '**Failures should be shared knowledge** — one run discovering an outage should spare every other run the timeout',
        '**You want fast failure during outages** — `CircuitOpenError` returns instantly instead of waiting out another timeout',
      ],
      sourceDescription:
        'One file ships the whole component: the breaker state machine (closed → open → half-open) as a per-key coordinator workflow, a cooldown timer child, and the `withBreaker()` consumer API that checks, runs, and reports in one call.',
      howItWorks: [
        '**Single event channel** — checks, success/failure reports, and cooldown-timer pings all arrive as messages on one hook; the loop never blocks on anything else, so checks are answered instantly even while open.',
        '**Consecutive-failure threshold** — `FAILURE_THRESHOLD` failures in a row open the circuit and spawn a cooldown timer child carrying a sequence number; stale timers from superseded cooldowns are ignored.',
        '**Half-open probe** — after the cooldown message arrives, exactly one caller is allowed through. Success closes the circuit; failure re-opens it and restarts the cooldown.',
        '**Fail-open default** — if the coordinator is unreachable, `withBreaker` allows the call after `CHECK_TIMEOUT` (and disposes its stale reply hook). The breaker is an optimization, not a correctness gate.',
      ],
      adapting: [
        '**Call from workflow functions only** — `withBreaker()` creates hooks and uses durable sleep.',
        '**Pair with `RetryableError`** — catch `CircuitOpenError` and rethrow as `RetryableError` with `retryAfter` ≈ the cooldown, so the runtime reschedules instead of failing the run (see Usage tab).',
        '**Fail-closed if you must** — flip the `CHECK_TIMEOUT` race fallback to `allowed: false` when calling the dependency during coordinator unavailability is worse than skipping it.',
        '**Window-based thresholds** — the default counts consecutive failures; for a failure-rate window, track timestamps in the coordinator state.',
        '**Recycling resets the count** — the coordinator only recycles while closed and quiet, so the reset is benign; remove the recycle if you want eternal memory at the cost of an ever-growing event log.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'createHook()',
          url: '/docs/api-reference/workflow/create-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        {
          label: 'RetryableError',
          url: '/docs/api-reference/workflow/retryable-error',
        },
      ],
    },
  },
  {
    id: 'debounce',
    name: 'Debounce',
    logo: 'debounce',
    description:
      'Collapse a burst of events into one action that fires after the burst goes quiet — per key, across processes.',
    longDescription:
      'Distributed debounce-by-key. Call `debounceSend(key, payload)` from anywhere server-side as events arrive; a short-lived coordination workflow per key absorbs the burst, and when `quietMs` passes with no new events it fires your action exactly once with the latest payload, then exits. Each event "resets the timer" by spawning a fresh timer child with a bumped sequence number — stale timers are simply ignored, so the coordinator never blocks and never loses an event to a racing timeout.',
    tags: ['debounce', 'throttle', 'events', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/debounce',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/debounce.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/debounce',
    files: [
      {
        path: 'workflows/debounce-workflow.ts',
        description:
          'The complete component — per-key coordinator, timer child, `debounceSend()` API, and the `onDebounceFire` step you replace with your action.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/debounce-workflow.ts',
        code: debounceDisplaySource,
        installCode: debounceFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Call debounceSend() from routes, webhooks, or steps',
        code: debounceUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**At most one notification per quiet window** — N triggering events, one email',
        '**Rebuild an index / cache after writes settle** instead of once per write',
        '**Sync to a third party when an edit session ends** rather than on every keystroke',
      ],
      sourceDescription:
        'One file ships the whole component: the per-key coordinator that absorbs the burst, the timer child that turns the quiet period into a message, the `debounceSend()` entry point, and an `onDebounceFire` step whose body you replace with your action.',
      howItWorks: [
        '**Lazy per-key runs** — the first event of a burst starts the coordinator; it exits after firing, so debounce runs are short-lived and cheap.',
        '**Timer reset as a message** — each event bumps a sequence number and spawns a fresh timer child (`sleep(quietMs)` then ping). A timer ping only fires the action if its ID is still current; superseded timers are ignored.',
        '**Latest-payload semantics** — the action receives only the most recent payload. The burst count or full list is intentionally not kept (see Batch Aggregator for that).',
        "**Never-lost events** — an event landing just as the run exits simply starts a new burst via `debounceSend`'s ensure-and-retry loop.",
      ],
      adapting: [
        "**Replace `onDebounceFire`** with your real action — and make it idempotent: an event acknowledged while the fire step is executing is dropped by the exiting run, and the sender's next event starts a fresh burst, so two quick fires (or a swallowed payload) are possible in rare timing windows.",
        '**`debounceSend()` works anywhere server-side** — API routes, server actions, webhook handlers, or steps.',
        '**Leading-edge variant** — fire immediately on the first event, then use the coordinator only to suppress repeats until quiet.',
        '**Throttle instead of debounce** — to fire every `intervalMs` during a sustained burst (not just at the end), flush in the timer branch and continue the loop instead of returning.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
      ],
    },
  },
  {
    id: 'batch-aggregator',
    name: 'Batch Aggregator',
    logo: 'batch-aggregator',
    description:
      'Buffer individually-arriving events, flush once at N items or T elapsed — the inverse of fan-out batching.',
    longDescription:
      "Turn a stream of single events into efficient bulk operations. Call `aggregatorSend(key, item)` as events arrive; a short-lived coordination workflow per key buffers them and flushes exactly once — when the buffer reaches `MAX_ITEMS` or `MAX_WAIT_MS` after the first item, whichever comes first — then exits, and the next item opens a fresh buffer. Where the Batching pattern fans a known list out into chunks, the aggregator fans unknown arrivals IN: it's the missing half of batch processing.",
    tags: ['aggregation', 'buffer', 'batch', 'events', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/batch-aggregator',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/batch-aggregator.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/batch-aggregator',
    files: [
      {
        path: 'workflows/batch-aggregator-workflow.ts',
        description:
          'The complete component — per-key buffer coordinator, flush-deadline timer child, `aggregatorSend()` API, and the `flushBatch` step you replace with your bulk operation.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/batch-aggregator-workflow.ts',
        code: batchAggregatorDisplaySource,
        installCode: batchAggregatorFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Call aggregatorSend() from routes, webhooks, or steps',
        code: batchAggregatorUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Bulk APIs and warehouses** — collect single events into one bulk insert / batch call',
        '**Digest semantics** — "collect activity for 5 minutes, then send one summary"',
        '**Bursty producers, slow consumers** — absorb the burst durably and hand the consumer one batch',
      ],
      sourceDescription:
        'One file ships the whole component: the per-key buffer coordinator, the flush-deadline timer child, the `aggregatorSend()` entry point, and a `flushBatch` step whose body you replace with your bulk operation.',
      howItWorks: [
        '**First item opens the window** — it lazily starts the coordinator and spawns the flush-deadline timer (a child that sleeps and pings back, so the buffer loop never blocks).',
        '**Two flush triggers, one winner** — `MAX_ITEMS` reached, or the deadline ping with the current sequence number. Either way the buffer flushes exactly once and the run exits.',
        '**Buffered in workflow state** — items survive restarts with the run; no Redis or queue infrastructure.',
        "**Never-lost items** — an item landing just as a flush exits starts a fresh buffer via `aggregatorSend`\'s ensure-and-retry loop.",
      ],
      adapting: [
        '**Replace `flushBatch`** with your bulk operation and tune `MAX_ITEMS` / `MAX_WAIT_MS`.',
        '**Pass a stable `id` to `aggregatorSend`** (event ID, or stepId + index from steps) — sends from retried steps are at-least-once, and the coordinator dedupes by id.',
        '**Know the flush window** — an item resumed while the flush step is executing is acknowledged but lands in a buffer the exiting run never reads. The window is the flush duration; make flushes fast, and prefer idempotent bulk operations so a rare re-send is safe.',
        '**Keep items small** — they live in the event log; for large payloads, send IDs and hydrate inside the flush step.',
        '**Sliding window** — to extend the deadline on every item (flush only after a quiet period), bump the timer sequence and spawn a fresh timer per item, like the Debounce pattern does.',
        '**Per-tenant streams** — key by tenant/user (`analytics:tenant-42`) to get independent buffers with independent deadlines.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
      ],
    },
  },
  {
    id: 'singleton-run',
    name: 'Singleton Run',
    logo: 'singleton-run',
    description:
      'At most one live run per key — getOrStart() dedupes starts, and a built-in mailbox feeds the run.',
    longDescription:
      "Guarantee at most one live workflow run per semantic key. The singleton's first act is creating a hook with a deterministic token — that registration doubles as the liveness marker, the start-dedupe mutex, and a mailbox. `getOrStart(key, startRun)` probes the token and only starts a run when none is alive; if two callers race, the duplicate detects the conflict via `getConflict()` and returns `{ dedupedTo: winnerRunId }` cleanly — exactly one survives. `sendToSingleton(key, message)` feeds the live run from anywhere — API routes, webhooks, other workflows — giving you actor-style mailbox loops with no extra infrastructure.",
    tags: ['singleton', 'dedupe', 'resume-or-start', 'actor', 'coordination'],
    categories: ['advanced'],
    versions: ['v4', 'v5'],
    patternType: 'component',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/singleton-run',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/singleton-run.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/singleton-run',
    files: [
      {
        path: 'workflows/singleton-run-workflow.ts',
        description:
          'The component — `getOrStart()`, `sendToSingleton()`, the mailbox hook — plus an example actor-style session workflow.',
      },
    ],
    snippets: [
      {
        label: 'Component',
        lang: 'tsx',
        caption: 'workflows/singleton-run-workflow.ts',
        code: singletonRunDisplaySource,
        installCode: singletonRunFullSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'getOrStart + sendToSingleton from an API route',
        code: singletonRunUsageSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**One live session / sync / consumer per user, tenant, or resource** — dedupe starts by key instead of tracking run IDs in your database',
        '**Resume-or-start** — reconnect to in-flight work idempotently from stateless request handlers',
        '**Actor-style mailboxes** — a long-lived loop fed messages from routes and webhooks, processed in arrival order',
      ],
      sourceDescription:
        'One file ships the component (`getOrStart()`, `sendToSingleton()`, the `singletonMailbox` hook and token scheme) plus a worked example: a per-user session workflow that processes mailbox messages until told to stop.',
      howItWorks: [
        '**The hook IS the registry** — creating `singletonMailbox` with the deterministic `singleton:<key>` token is what makes the run discoverable; `getHookByToken()` is the lookup.',
        '**Conflict as mutex** — two racing starts both come up, but the duplicate detects the conflict via `getConflict()` (which commits hook registration early) and returns `{ dedupedTo: winnerRunId }` before doing any work. No lock service needed.',
        '**Mailbox loop** — `await mailbox` in a loop yields messages in arrival order; messages sent while the run is busy queue up in the channel.',
        '**Clean exit, clean restart** — when the run returns (stop message, recycle), the token frees up and the next `getOrStart` begins a fresh singleton.',
      ],
      adapting: [
        "**Create the mailbox first** — it must be the workflow's first act so a duplicate dies before causing side effects.",
        "**Conflict losers resolve cleanly** — a duplicate run returns `{ dedupedTo: winnerRunId }` instead of failing; a caller holding the loser's runId can read that return value to find the winner.",
        '**Recycle long-lived singletons** — exit after N messages and let the next send restart the run (see Upgrading Workflows for the state-carrying version).',
        '**Idle shutdown** — combine with the Debounce timer trick to exit after a quiet period instead of an explicit stop message.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'getHookByToken()',
          url: '/docs/api-reference/workflow-api/get-hook-by-token',
        },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        {
          label: 'resumeHook()',
          url: '/docs/api-reference/workflow-api/resume-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'upgrading-workflows',
    name: 'Upgrading Workflows',
    logo: 'upgrading-workflows',
    description:
      'Respawn a long-running workflow on the latest deployment — shipped fixes take effect on the very next event, no migration needed.',
    longDescription:
      'Ship fixes to in-flight runs without migrating state. Each iteration handles one event, then calls `start(self, [newState], { deploymentId: "latest" })` from inside a step to spawn its successor on whichever deployment is currently live. Because state travels as a plain function argument, the logical "session" survives indefinite redeploys — the next run starts fresh on new code and picks up exactly where the last one left off. Useful for workflows that wait on a long timescale (days/weeks) and need shipped fixes to apply immediately, or for any pattern where you want to iterate freely without versioning workflow logic. Ships Method 1 (spawn on every iteration) out of the box; the same start and resume routes also support Method 2 (dedicated upgrade hook racing the main work hook) described in the docs.',
    tags: ['upgrade', 'respawn', 'deployment', 'long-running', 'versioning'],
    categories: ['common', 'advanced'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/upgrading-workflows',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/upgrading-workflows.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/upgrading-workflows',
    envVars: [
      {
        name: 'VERCEL_DEPLOYMENT_ID',
        description:
          'Set automatically by Vercel — used to detect which deployment a run is executing on.',
      },
      {
        name: 'VERCEL_GIT_COMMIT_SHA',
        description:
          'Set automatically by Vercel — surfaced in the run state for observability.',
      },
    ],
    files: [
      {
        path: 'workflows/upgrading-workflows-workflow.ts',
        description:
          'The self-upgrading workflow — one iteration per run, blocks on `resumeHook`, computes new state, then spawns the next iteration with `deploymentId: "latest"`.',
      },
      {
        path: 'app/api/upgrade/route.ts',
        description:
          'POST endpoint that starts the first iteration of the chain with optional initial state.',
      },
      {
        path: 'app/api/upgrade/resume/route.ts',
        description:
          'POST endpoint that resumes the active iteration by `runId`, triggering a state update and a successor spawn.',
      },
    ],
    snippets: [
      {
        label: 'Method 1 — per-event spawn',
        lang: 'tsx',
        caption: 'workflows/upgrading-workflows-workflow.ts',
        description:
          'One run per event. After each resume, state is computed and the next iteration is spawned with `deploymentId: "latest"`. Every event automatically picks up the latest code.',
        code: upgradingWorkflowsWorkflowSource,
        installCode: upgradingWorkflowsMethod1InstallSource,
      },
      {
        label: 'Method 2 — explicit upgrade hook',
        lang: 'tsx',
        caption: 'workflows/upgrading-workflows-workflow.ts',
        description:
          'Long-running loop that handles many events per run. A separate `upgradeHook` races the work hook — fire it when you want to force a respawn on the latest deployment.',
        code: upgradingWorkflowsMethod2Source,
        installCode: upgradingWorkflowsMethod2InstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/upgrade/route.ts',
        code: upgradingWorkflowsStartRouteSource,
      },
      {
        label: 'Resume route',
        lang: 'tsx',
        caption: 'app/api/upgrade/resume/route.ts',
        code: upgradingWorkflowsResumeRouteSource,
      },
    ],
  },
  {
    id: 'polling',
    name: 'Polling',
    logo: 'polling',
    description:
      'Wait for an external condition with exponential backoff and a deadline — durable sleeps make day-long waits free.',
    longDescription:
      "Poll an external system until a condition holds: a deployment goes live, an export finishes, a KYC review lands. The check is a step (so transient probe failures retry automatically), the wait between polls is a durable sleep (so a day-long wait costs nothing and survives restarts), and backoff plus a deadline keep both fast and slow systems cheap. If the system you're waiting on offers webhooks, prefer the Webhooks pattern — poll only when you must.",
    tags: ['polling', 'wait', 'backoff', 'condition'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/polling',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/polling.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/polling',
    files: [
      {
        path: 'workflows/polling-workflow.ts',
        description:
          '`waitForCondition()` loop with exponential backoff + deadline, and the `checkCondition` step you replace with your probe.',
      },
      {
        path: 'app/api/polling/route.ts',
        description: 'POST endpoint that starts a wait for a given target.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/polling-workflow.ts',
        code: pollingDisplaySource,
        installCode: pollingFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/polling/route.ts',
        code: pollingStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Waiting on slow external processes** — deployments, exports, batch jobs, model fine-tunes',
        '**Human-speed waits** — KYC review, domain verification, manual fulfilment',
        '**No webhook available** — when there is one, use the Webhooks pattern instead and skip polling entirely',
      ],
      sourceDescription:
        'The workflow loops: probe step → done? → durable sleep with exponential backoff → probe again, bounded by a total deadline. Replace the `checkCondition` step body with your real probe.',
      howItWorks: [
        '**The check is a step** — a flaky probe (5xx, network) is retried by the runtime as a step failure; only `{ done: false }` schedules the next poll.',
        '**Durable sleeps between polls** — zero compute while waiting; the run survives restarts and deploys mid-wait.',
        '**Exponential backoff** — interval doubles from `INITIAL_INTERVAL_MS` up to `MAX_INTERVAL_MS`, so fast conditions resolve fast and slow ones poll cheaply.',
        '**Deadline** — the loop throws `PollTimeoutError` rather than polling forever; catch it in the caller to handle the timeout as data.',
      ],
      adapting: [
        '**Replace `checkCondition`** with your probe and result shape; return `{ done: true, value }` to resolve the wait with data.',
        '**Tune the constants** to expected time-to-ready — polling a 30-second deploy and a 3-day review want very different curves.',
        '**Timeout as data** — return `{ timedOut: true }` instead of throwing if the caller should branch rather than fail.',
        "**Cancellable waits** — race the loop against a hook (see the Scheduling pattern's `cancellableSleep`) to abort a wait from outside.",
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'dead-letter-queue',
    name: 'Dead Letter Queue',
    logo: 'dead-letter-queue',
    description:
      'Isolate poison items instead of failing the batch — record exhausted failures with context, keep processing, redrive later.',
    longDescription:
      "Process a batch where individual failures must not abort the rest. Each item runs in a step with the runtime's automatic retries; an item that exhausts them (or throws `FatalError`) is recorded to a dead letter queue with its payload and error, and the batch keeps moving. A redrive workflow pulls dead letters and reprocesses them through the same batch workflow once the underlying issue is fixed.",
    tags: ['dlq', 'errors', 'batch', 'redrive', 'resilience'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/dead-letter-queue',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/dead-letter-queue.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/dead-letter-queue',
    files: [
      {
        path: 'workflows/dead-letter-queue-workflow.ts',
        description:
          '`processWithDeadLetters()` batch loop + `redriveDeadLetters()` + the steps you replace: `processItem` and the DLQ sink.',
      },
      {
        path: 'app/api/dead-letter-queue/route.ts',
        description:
          'POST endpoint that starts a batch, or a redrive of dead letters.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/dead-letter-queue-workflow.ts',
        code: deadLetterQueueDisplaySource,
        installCode: deadLetterQueueFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/dead-letter-queue/route.ts',
        code: deadLetterQueueStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**One malformed record must not block thousands of good ones**',
        '**Failures need a paper trail** — payload + error captured for inspection and replay',
        '**Redrive semantics** — fix the bug, reprocess exactly what failed',
      ],
      sourceDescription:
        'The batch loop catches per-item errors only AFTER the runtime has retried the step — so the DLQ receives genuinely poisoned items, not transient blips. The redrive workflow feeds dead letters back through the same batch.',
      howItWorks: [
        '**Retries happen below the catch** — `processItem` is a step; the runtime retries transient failures before the workflow ever sees an error.',
        '**`FatalError` short-circuits** — throw it for permanent failures (validation, 404s) to dead-letter immediately without burning retries.',
        "**The DLQ sink is a boring step** — a table insert or queue push with no interesting failure modes; it's the safety net.",
        '**Redrive reuses the batch** — `redriveDeadLetters` fetches dead items and starts `processWithDeadLetters` over them; items that fail again simply dead-letter again.',
      ],
      adapting: [
        '**Replace `processItem`** with your real work and `sendToDeadLetterQueue` / `fetchDeadLetters` with your real sink (a Postgres table is plenty).',
        '**Cap redrive loops** — track an `attempts` field in the payload and stop redriving after N failures.',
        '**Alert on dead letters** — the sink step is a natural place to also ping Slack/PagerDuty.',
        "**Large batches** — combine with the Batching pattern's chunked processing.",
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'FatalError',
          url: '/docs/api-reference/workflow/fatal-error',
        },
        {
          label: 'RetryableError',
          url: '/docs/api-reference/workflow/retryable-error',
        },
        { label: '"use step"', url: '/docs/foundations/workflows-and-steps' },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'recurring-cron',
    name: 'Recurring Cron',
    logo: 'recurring-cron',
    description:
      'A self-rescheduling recurring job with drift correction, clean stop, and continue-as-new deployment adoption.',
    longDescription:
      'Run a job every interval — forever — without cron infrastructure. The workflow sleeps to each ABSOLUTE due time (anchored on the schedule, not on "now", so drift never accumulates), runs the job as a retried step, and advances. After N iterations it hands its state to a fresh run started with `deploymentId: "latest"` (continue-as-new), keeping the event log bounded and adopting new code automatically. A stop hook raced against each sleep ends the schedule cleanly.',
    tags: ['cron', 'recurring', 'schedule', 'continue-as-new'],
    categories: ['common'],
    versions: ['v4', 'v5'],
    patternType: 'template',
    homepage: 'https://workflow-sdk.dev',
    docsUrl: 'https://workflow-sdk.dev/patterns/recurring-cron',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/recurring-cron.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/recurring-cron',
    files: [
      {
        path: 'workflows/recurring-cron-workflow.ts',
        description:
          '`recurringCron()` generation loop + stop hook + the `runJob` step you replace with your recurring work.',
      },
      {
        path: 'app/api/recurring-cron/route.ts',
        description: 'POST endpoint that starts or stops a named schedule.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/recurring-cron-workflow.ts',
        code: recurringCronDisplaySource,
        installCode: recurringCronFullSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/recurring-cron/route.ts',
        code: recurringCronStartRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Hourly/daily syncs, digests, cleanups** — with each tick durable and retried, and no cron service to operate',
        '**Schedules that outlive deployments** — continue-as-new adopts new code within one generation',
        '**One-off deferred actions?** Use the Scheduling pattern instead; this one is for repetition',
      ],
      sourceDescription:
        'One generation = `ITERATIONS_PER_RUN` ticks. Each tick sleeps to the absolute `nextDueAt`, races a stop hook, runs the job, and advances the anchor by the interval. The last act of a generation starts its successor with `deploymentId: "latest"`.',
      howItWorks: [
        "**Drift correction** — `sleep(new Date(nextDueAt))` targets the schedule's absolute time; a slow tick shrinks the next sleep instead of shifting every future tick.",
        '**Continue-as-new** — handing state to a fresh run bounds the event log and is the moment new deployments are adopted. Generation length (interval × iterations) should stay ≲ a day.',
        "**Clean stop, accidental-fork guard** — each generation's sleep races a stop hook whose token is generation-keyed (`cron:<name>:<generation-start>`). Resuming it exits between ticks; the same token also guards against schedule forking: if the continue-as-new step ever retried after a successful `start()`, the duplicate generation dies on the token conflict instead of running a parallel schedule forever.",
        '**No overlap by default** — a long tick delays the next one. For overlapping ticks, spawn `runJob` as a child workflow instead of awaiting it.',
      ],
      adapting: [
        '**Replace `runJob`** and tune `INTERVAL_MS` / `ITERATIONS_PER_RUN`.',
        "**Idempotent start** — wrap the initial `start()` with the Singleton Run pattern's `getOrStart()` so re-deploys and retries can't create duplicate schedules.",
        '**Calendar alignment** — for "9am daily" semantics, compute the next `nextDueAt` with a calendar/timezone library inside a step.',
        '**Observability** — the `iteration` counter in state gives every tick a stable identity across generations.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
      ],
    },
  },
  {
    id: 'stripe',
    name: 'Stripe',
    logo: 'stripe',
    description:
      'Dunning as one durable function — retry failed payments on a schedule, exit the moment the customer pays.',
    longDescription:
      'Failed-payment recovery (dunning) as a single workflow run per invoice. Stripe\'s `invoice.payment_failed` webhook starts the run; each grace period races a durable sleep against an `invoice.paid` hook resumed by the webhook route, so the moment the customer fixes their card the run exits with "recovered" — no polling, no state machine spread across tables. If the whole escalating schedule fails, the account downgrades exactly once.',
    tags: ['stripe', 'payments', 'dunning', 'billing', 'webhooks'],
    categories: ['provider', 'payments'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    dependencies: ['stripe'],
    homepage: 'https://stripe.com',
    docsUrl: 'https://docs.stripe.com/billing/revenue-recovery',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/stripe.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/stripe',
    envVars: [
      {
        name: 'STRIPE_SECRET_KEY',
        description: 'Stripe API secret key.',
        getKeyUrl: 'https://dashboard.stripe.com/apikeys',
        exampleValue: 'sk_live_********',
      },
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        description: 'Signing secret for the webhook endpoint.',
        getKeyUrl: 'https://dashboard.stripe.com/webhooks',
        exampleValue: 'whsec_********',
      },
    ],
    files: [
      {
        path: 'workflows/stripe-workflow.ts',
        description:
          '`dunningWorkflow()` — the escalating retry timeline + `invoicePaid` hook.',
      },
      {
        path: 'app/api/webhooks/stripe/route.ts',
        description:
          'Stripe webhook endpoint — verifies signatures, starts dunning on payment_failed, resumes the hook on invoice.paid.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/stripe-workflow.ts',
        code: stripeWorkflowSource,
        installCode: stripeWorkflowInstallSource,
      },
      {
        label: 'Webhook route',
        lang: 'tsx',
        caption: 'app/api/webhooks/stripe/route.ts',
        description:
          "One endpoint handles both event types: `invoice.payment_failed` starts a dunning run; `invoice.paid` resumes the matching run's hook (and is a no-op for invoices with no run waiting).",
        code: stripeWebhookRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Failed-payment recovery** where you want the timeline, notifications, and downgrade logic in your own code with per-invoice observability',
        '**Any multi-step billing timeline** — trial expiry sequences, seat true-ups, usage-cap warnings',
        '**Note:** Stripe Smart Retries can handle pure retrying; this pattern earns its keep when recovery involves YOUR side effects',
      ],
      sourceDescription:
        'One run per invoice owns the recovery timeline: notify → grace period (durable sleep raced against the `invoice.paid` hook) → retry the charge → escalate → downgrade once.',
      howItWorks: [
        '**Webhook starts the run** — `invoice.payment_failed` maps to `start(dunningWorkflow, …)`; the run IS the dunning state for that invoice.',
        '**Early exit on payment** — `invoice.paid` resumes the hook keyed by invoice ID; whichever grace-period race is in flight resolves to "paid" and the run returns "recovered".',
        '**Escalating schedule** — `RETRY_DELAYS` drives notify → wait → retry rounds; each retry charges via `stripe.invoices.pay`.',
        '**Exactly-once downgrade** — the downgrade step runs only after every round fails, and is retried/recorded like any step.',
      ],
      adapting: [
        '**Verify signatures first** — the route uses `stripe.webhooks.constructEvent`; never resume hooks from unverified payloads.',
        '**Tune `RETRY_DELAYS`** to your dunning policy, and swap `notifyCustomer` for your email provider (see the Resend pattern).',
        '**Make the downgrade yours** — cancel subscriptions, flip entitlements, or open a CS ticket instead.',
        "**Idempotent starts** — Stripe retries webhooks; use the Singleton Run pattern's `getOrStart()` keyed by invoice ID to dedupe.",
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        { label: 'start()', url: '/docs/api-reference/workflow-api/start' },
        {
          label: 'Stripe webhooks',
          url: 'https://docs.stripe.com/webhooks',
        },
      ],
    },
  },
  {
    id: 'slack-approval',
    name: 'Slack Approval',
    logo: 'slack-approval',
    description:
      'Human-in-the-loop where the Approve button lives in Slack — post, suspend, resume on click.',
    longDescription:
      "Gate a consequential action on a human decision made in Slack. The workflow posts an interactive message whose Approve / Reject buttons carry the hook token as their value, then suspends — zero compute while humans deliberate. Slack's interactivity webhook resumes the hook with the decision and who made it; a 24h deadline race turns silence into rejection. Same mechanics as the Human In The Loop pattern, different approval surface.",
    tags: ['slack', 'approval', 'human-in-the-loop', 'buttons'],
    categories: ['provider', 'communication'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    homepage: 'https://api.slack.com',
    docsUrl: 'https://api.slack.com/messaging/interactivity',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/slack-approval.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/slack-approval',
    envVars: [
      {
        name: 'SLACK_BOT_TOKEN',
        description: 'Bot token with chat:write scope.',
        getKeyUrl: 'https://api.slack.com/apps',
        exampleValue: 'xoxb-********',
      },
      {
        name: 'SLACK_CHANNEL_ID',
        description: 'Channel where approval requests are posted.',
      },
      {
        name: 'SLACK_SIGNING_SECRET',
        description: 'Used to verify interactivity payloads are from Slack.',
        getKeyUrl: 'https://api.slack.com/apps',
      },
    ],
    files: [
      {
        path: 'workflows/slack-approval-workflow.ts',
        description:
          '`requestSlackApproval()` — posts the interactive message, suspends on the decision hook with a deadline, runs the approved action.',
      },
      {
        path: 'app/api/slack/interactions/route.ts',
        description:
          "Slack interactivity endpoint — extracts the hook token from the clicked button's value and resumes the decision hook.",
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/slack-approval-workflow.ts',
        code: slackApprovalWorkflowSource,
        installCode: slackApprovalWorkflowInstallSource,
      },
      {
        label: 'Interactions route',
        lang: 'tsx',
        caption: 'app/api/slack/interactions/route.ts',
        code: slackApprovalRouteSource,
      },
    ],
    guide: {
      flatLayout: true,
      whenToUse: [
        '**Deploy gates, refunds, publishing** — anywhere the approvers already live in Slack',
        '**Approval state belongs in the workflow** — one run = one request, instead of a table + cron + reminder job',
        '**In-app approval UI instead?** See the Human In The Loop pattern — identical hook mechanics, React card surface',
      ],
      sourceDescription:
        'The workflow posts the Block Kit message (buttons carry the hook token as `value`), suspends on the decision hook raced against a 24h deadline, posts the resolution back to the channel, and runs the approved action only on approval.',
      howItWorks: [
        "**Token rides the button** — each button's `value` is the hook token, so the interactivity route needs no lookup table to find the right run.",
        "**Suspend while humans think** — the run costs nothing between post and click; restarts and deploys don't lose the pending approval.",
        '**Timeout = rejection** — the deadline race resolves `{ approved: false, decidedBy: "timeout" }` so silence is an explicit, logged outcome.',
        '**Double-clicks are safe** — a second click hits an already-consumed hook; the route swallows that error.',
      ],
      adapting: [
        '**Verify Slack signatures** — check `X-Slack-Signature` with your signing secret before resuming hooks; the route marks where.',
        '**Replace `performApprovedAction`** with the thing approval unlocks.',
        '**Escalation tiers** — on timeout, post to an escalation channel and wait again instead of rejecting.',
        '**Update the original message** — use `response_url` from the interactivity payload to replace the buttons with the outcome in place.',
      ],
      adaptingTitle: 'Tips',
      keyApis: [
        {
          label: 'defineHook()',
          url: '/docs/api-reference/workflow/define-hook',
        },
        { label: 'sleep()', url: '/docs/api-reference/workflow/sleep' },
        {
          label: 'Slack interactivity',
          url: 'https://api.slack.com/messaging/interactivity',
        },
        {
          label: 'Block Kit',
          url: 'https://api.slack.com/block-kit',
        },
      ],
    },
  },
  {
    id: 'resend',
    name: 'Resend',
    logo: 'resend',
    description: 'Onboarding email drip campaign.',
    longDescription:
      'A production-ready email drip campaign powered by Resend. New users get a welcome email immediately, then follow-ups spaced hours, days, or weeks apart — whatever you configure. Each send is a workflow step that gets persisted once it succeeds, so if your server restarts or crashes mid-campaign, no one ever gets a duplicate. The waits between emails cost nothing (the campaign is fully paused, not idling), so it can span days or weeks without keeping anything running. And the moment a user converts, calling a single function from your app stops the whole thing instantly — no leftover emails, no extra database tables, no flag-checking on every send.',
    tags: ['email', 'drip', 'cancellable', 'durable'],
    categories: ['provider'],
    versions: ['v4', 'v5'],
    patternType: 'example',
    dependencies: ['ms', 'resend'],
    homepage: 'https://resend.com',
    docsUrl: 'https://resend.com/docs/send-with-nodejs',
    sourceUrl:
      'https://github.com/vercel/workflow/blob/main/docs/lib/patterns/snippets/resend.ts',
    shadcnSlug: 'https://workflow-sdk.dev/r/resend',
    envVars: [
      {
        name: 'RESEND_API_KEY',
        description: 'API key from your Resend account.',
        getKeyUrl: 'https://resend.com/api-keys',
        exampleValue: 're_********',
      },
    ],
    files: [
      {
        path: 'workflows/resend-workflow.ts',
        description:
          'The durable email drip workflow — `emailSequence()` + `cancelNudges` hook + the three send-email steps.',
      },
      {
        path: 'app/api/providers/resend/route.ts',
        description:
          'POST endpoint that starts a new campaign and pre-cancels any in-flight run for the same email.',
      },
      {
        path: 'app/api/providers/resend/cancel/route.ts',
        description:
          'POST endpoint your app calls when the user converts — resumes the hook so the campaign exits cleanly.',
      },
    ],
    snippets: [
      {
        label: 'Workflow',
        lang: 'tsx',
        caption: 'workflows/resend-workflow.ts',
        code: resendWorkflowSource,
        installCode: resendWorkflowInstallSource,
      },
      {
        label: 'Start route',
        lang: 'tsx',
        caption: 'app/api/providers/resend/route.ts',
        code: resendStartRouteSource,
      },
      {
        label: 'Cancel route',
        lang: 'tsx',
        caption: 'app/api/providers/resend/cancel/route.ts',
        code: resendCancelRouteSource,
      },
      {
        label: 'Usage',
        role: 'usage',
        lang: 'tsx',
        caption: 'Trigger the campaign from your app',
        code: resendUsageSource,
      },
    ],
  },
];

export function getRegistryItem(id: string): RegistryItem | undefined {
  return registryItems.find((item) => item.id === id);
}

export function getRegistryItemIds(): string[] {
  return registryItems.map((item) => item.id);
}

export const categoryLabels: Record<RegistryCategory, string> = {
  agent: 'Agents',
  vercel: 'Vercel',
  common: 'Common',
  advanced: 'Advanced',
  provider: 'Providers',
  storage: 'Storage',
  ai: 'AI',
  auth: 'Auth',
  payments: 'Payments',
  communication: 'Communication',
  other: 'Other',
};

export const patternTypeLabels: Record<RegistryPatternType, string> = {
  component: 'Component',
  template: 'Template',
  example: 'Example',
};
