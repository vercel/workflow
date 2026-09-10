/**
 * Source snippets for the Chat SDK registry entry.
 *
 * Each export is a raw string of source code that the detail page renders
 * with shiki. The canonical reference for these snippets is the Chat SDK
 * cookbook integration — `content/docs/cookbook/integrations/chat-sdk.mdx`.
 *
 * The pattern: one conversation thread = one durable workflow run. Chat
 * SDK's thread state holds the `runId`, so inbound messages route to a
 * `start()` (first message) or `resumeHook()` (every subsequent message).
 * Outbound chat side-effects (`thread.post`, `thread.subscribe`, …) live
 * inside `"use step"` functions that dynamically import the bot — keeps
 * adapter packages out of the workflow sandbox.
 *
 * Note on escaping: template literal placeholders inside the snippet are
 * escaped as `\${...}` so they stay literal here.
 */

export const chatSdkBotSource = `import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";

const adapters = {
  slack: createSlackAdapter(),
};

// The thread-level state stored by Chat SDK. \`runId\` ties a conversation
// thread to its durable workflow session.
export interface ThreadState {
  runId?: string;
}

// \`registerSingleton()\` is required: Chat SDK re-hydrates \`Thread\` objects
// inside step functions and needs a registered singleton to resolve
// adapters and state for those rehydrated instances.
export const bot = new Chat<typeof adapters, ThreadState>({
  userName: "durable-bot",
  adapters,
  state: createRedisState(),
  dedupeTtlMs: 600_000,
}).registerSingleton();
`;

export const chatSdkWorkflowSource = `import { Message, reviver, type Thread, type SerializedMessage } from "chat";
import { defineHook, getWorkflowMetadata } from "workflow";
import type { ThreadState } from "@/lib/bot";

// Hook payload type — exported so webhook handlers can import it without
// pulling in workflow-specific modules.
export type ChatTurnPayload = { message: SerializedMessage };

const chatTurnHook = defineHook<ChatTurnPayload>();

// Posting back to the platform is a step — adapter packages use Node-only
// modules that aren't available in the workflow sandbox, so we import the
// bot dynamically from inside the step body.
async function postAssistantMessage(
  thread: Thread<ThreadState>,
  text: string
) {
  "use step";
  const { bot } = await import("@/lib/bot");
  await bot.initialize();
  await thread.post(text);
}

async function runTurn(text: string) {
  "use step";
  // Your AI SDK call, database lookup, tool loop, etc.
  return \`You said: \${text}\`;
}

async function handleMessage(
  thread: Thread<ThreadState>,
  message: Message
) {
  const text = message.text.trim();
  if (text.toLowerCase() === "done") return false;

  const reply = await runTurn(text);
  await postAssistantMessage(thread, reply);
  return true;
}

export async function durableChatSession(payload: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  // The handler serializes \`thread\` + \`message\` with \`toJSON()\`; we revive
  // them here using Chat SDK's standalone \`reviver\`.
  const { thread, message } = JSON.parse(payload, reviver) as {
    thread: Thread<ThreadState>;
    message: Message;
  };

  const hook = chatTurnHook.create({ token: workflowRunId });

  await postAssistantMessage(
    thread,
    "Session started. Reply here; send \\\`done\\\` to stop."
  );

  if (!(await handleMessage(thread, message))) return;

  // One hook resumption = one turn. The workflow stays suspended between
  // messages — zero compute cost while idle.
  while (true) {
    const { message: nextRaw } = await hook;
    const next = Message.fromJSON(nextRaw);
    if (!(await handleMessage(thread, next))) return;
  }
}
`;

export const chatSdkWorkflowInstallSource = `/**
 * Chat SDK Integration — durable multi-turn chat bot backed by a Workflow run.
 *
 * THE PATTERN:
 *   1. One conversation thread = one workflow run. The run's ID is stored in
 *      Chat SDK's thread state so follow-up messages route to the same run.
 *   2. The bot's message handler calls start() on the first message and
 *      resumeHook() on every subsequent message, passing a serialized message.
 *   3. Inside the workflow, a chatTurnHook (token = runId) suspends between
 *      turns — zero compute cost while waiting for the next message.
 *   4. Platform side effects (thread.post, thread.subscribe) run inside "use
 *      step" functions that dynamically import the bot — keeps adapter
 *      packages out of the workflow sandbox.
 *
 * USEFUL WHEN:
 *   - You're building a Slack / Telegram / Teams bot that needs durable state.
 *   - Long AI responses should survive process restarts mid-generation.
 *   - Tool calls in the bot should be retried without re-running on replay.
 *   - You want the bot to maintain conversation state across reconnections.
 *
 * DEPENDENCIES — run these before the workflow will compile:
 *   pnpm add chat                    # Chat SDK core (provides Message, Thread, etc.)
 *   pnpm add @chat-adapter/slack     # or telegram, teams, discord — your platform
 *   pnpm add @chat-state/redis       # or another state backend
 *
 *   Then create lib/bot.ts exporting:
 *     export const bot = createBot({ adapter, state });
 *     export type ThreadState = { workflowRunId?: string };
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the runTurn step body with your AI SDK call, tool loop, or
 *     database lookup — any async logic that should be durable.
 *   - Replace createSlackAdapter() with your platform adapter (Telegram,
 *     Teams, Discord, etc.) from the @chat-adapter/* packages.
 *   - Replace createRedisState() with your preferred state backend.
 *   - Change "done" to your own session-termination signal.
 *   - Add more bot.onXxx() event handlers in the handlers file for
 *     reactions, emoji, DMs, slash commands, etc.
 *
 * DOCS: https://workflow-sdk.dev/patterns/chat-sdk
 */
import { Message, reviver, type Thread, type SerializedMessage } from "chat";
import { defineHook, getWorkflowMetadata } from "workflow";
import type { ThreadState } from "@/lib/bot";

// Hook payload type — exported so webhook handlers can import it without
// pulling in workflow-specific modules.
export type ChatTurnPayload = { message: SerializedMessage };

// One hook per run, token = runId. Reused every turn (created once outside
// the loop to avoid HookConflictError on subsequent turns).
const chatTurnHook = defineHook<ChatTurnPayload>();

// Posting back to the platform is a "use step" — adapter packages use
// Node-only modules unavailable in the workflow sandbox, so we import the
// bot dynamically from inside the step body.
async function postAssistantMessage(
  thread: Thread<ThreadState>,
  text: string
) {
  "use step";
  const { bot } = await import("@/lib/bot");
  await bot.initialize();
  await thread.post(text);
}

async function runTurn(text: string) {
  "use step";
  // Replace with your AI SDK call, tool loop, or database lookup.
  return \`You said: \${text}\`;
}

async function handleMessage(
  thread: Thread<ThreadState>,
  message: Message
) {
  const text = message.text.trim();
  if (text.toLowerCase() === "done") return false; // session exit signal

  const reply = await runTurn(text);
  await postAssistantMessage(thread, reply);
  return true;
}

export async function durableChatSession(payload: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  // The handler serializes thread + message as JSON; reviver rehydrates them.
  const { thread, message } = JSON.parse(payload, reviver) as {
    thread: Thread<ThreadState>;
    message: Message;
  };

  // One hook per run, reused every turn.
  const hook = chatTurnHook.create({ token: workflowRunId });

  await postAssistantMessage(
    thread,
    "Session started. Reply here; send \`done\` to stop."
  );

  if (!(await handleMessage(thread, message))) return;

  // One hook resumption = one turn. The workflow suspends between messages
  // — zero compute cost while idle.
  while (true) {
    const { message: nextRaw } = await hook;
    const next = Message.fromJSON(nextRaw);
    if (!(await handleMessage(thread, next))) return;
  }
}
`;

export const chatSdkHookTypeSource = `import type { SerializedMessage } from "chat";

// Importing this from the handler module keeps adapter dependencies out
// of the workflow's import graph.
export type ChatTurnPayload = {
  message: SerializedMessage;
};
`;

export const chatSdkHookTypeInstallSource = `/**
 * Chat SDK — ChatTurnPayload hook type.
 *
 * THE PATTERN:
 *   This file defines only the payload type used by the chat-turn hook.
 *   Keeping it in a separate module means the workflow file can import the
 *   type without pulling in handler-level dependencies (Chat SDK adapters,
 *   DB clients, etc.) into the workflow's import graph.
 *
 * USEFUL WHEN:
 *   - Your workflow and webhook handler live in different modules and you want
 *     a clean shared type without circular imports.
 *   - You are building on top of the Chat SDK durable-chat-session pattern.
 *
 * DEPENDENCIES:
 *   pnpm add chat    # Chat SDK core (provides SerializedMessage)
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Add any extra fields your handler needs to pass to the workflow turn
 *     (e.g. userId, metadata, attachments).
 *   - Import this type from both the workflow and the webhook handler.
 *
 * DOCS: https://workflow-sdk.dev/patterns/chat-sdk
 */
import type { SerializedMessage } from "chat";

// Importing this from the handler module keeps adapter dependencies out
// of the workflow's import graph.
export type ChatTurnPayload = {
  message: SerializedMessage;
};
`;

export const chatSdkHandlersSource = `import type { Message, Thread } from "chat";
import { getRun, resumeHook, start } from "workflow/api";
import { bot, type ThreadState } from "@/lib/bot";
import { durableChatSession } from "@/app/workflows/chat-sdk-workflow";
import type { ChatTurnPayload } from "@/app/workflows/chat-sdk-workflow";

async function startSession(
  thread: Thread<ThreadState>,
  message: Message
) {
  const run = await start(durableChatSession, [
    JSON.stringify({
      thread: thread.toJSON(),
      message: message.toJSON(),
    }),
  ]);
  await thread.setState({ runId: run.runId });
}

async function routeTurn(
  thread: Thread<ThreadState>,
  message: Message
) {
  const state = await thread.state;

  // No run yet, or the previous run finished — start fresh.
  if (!state?.runId || !(await getRun(state.runId).exists)) {
    await startSession(thread, message);
    return;
  }

  try {
    await resumeHook<ChatTurnPayload>(state.runId, {
      message: message.toJSON(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (msg.includes("not found") || msg.includes("expired")) {
      // Stale runId — start a new session rather than dropping the message.
      await startSession(thread, message);
      return;
    }
    throw err;
  }
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await routeTurn(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  await routeTurn(thread, message);
});
`;

export const chatSdkWebhookSource = `import "@/lib/chat-session-handlers";
import { after } from "next/server";
import { bot } from "@/lib/bot";

type Platform = keyof typeof bot.webhooks;

// Catch-all webhook route. Importing \`chat-session-handlers\` for its
// side-effects registers the event handlers before the first webhook
// arrives.
export async function POST(
  req: Request,
  ctx: RouteContext<"/api/webhooks/[platform]">
) {
  const { platform } = await ctx.params;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response(\`Unknown platform: \${platform}\`, { status: 404 });
  }

  return handler(req, { waitUntil: (task) => after(() => task) });
}
`;
