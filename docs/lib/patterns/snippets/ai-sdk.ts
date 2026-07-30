/**
 * Source snippets for the AI SDK registry entry.
 *
 * Each export is a raw string of source code that the detail page renders
 * with shiki. The canonical reference for these snippets is the AI SDK
 * cookbook integration — `content/docs/cookbook/integrations/ai-sdk.mdx`.
 *
 * The pattern: one workflow run = one full conversation. The workflow
 * suspends between turns on a hook and resumes when the next user message
 * arrives. `streamText()` runs inside a `"use step"` so each user turn is
 * the durable retry unit and its stream can be sliced by index for
 * follow-up turns. Tool calls inside a turn are NOT individually durable —
 * the `"use step"` directive is a no-op when called from another step.
 *
 * Note on escaping: template literal placeholders inside the snippet are
 * escaped as `\${...}` so they stay literal here.
 */

export const aiSdkWorkflowSource = `import { streamText, stepCountIs } from "ai";
import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import type { ModelMessage, UIMessageChunk } from "ai";
import { z } from "zod";

const MAX_TURNS = 20;

// One hook per workflow run drives the multi-turn loop. Each \`.resume()\`
// from the API route delivers the next user message to the workflow.
export const turnHook = defineHook({
  schema: z.object({ message: z.string() }),
});

// \`streamText\` invokes tool executes inside \`runTurn\` (a step), so tool
// calls are not individually durable — the entire turn retries together.
// Make side-effectful tools idempotent, or use DurableAgent for per-tool
// durability.
async function lookupOrder({ orderId }: { orderId: string }) {
  const res = await fetch(\`https://api.store.com/orders/\${orderId}\`);
  return res.json();
}

async function processRefund({
  orderId,
  reason,
}: { orderId: string; reason: string }) {
  const res = await fetch("https://api.store.com/refunds", {
    method: "POST",
    body: JSON.stringify({ orderId, reason }),
  });
  return res.json();
}

const TOOLS = {
  lookupOrder: {
    description: "Look up an order by ID",
    inputSchema: z.object({ orderId: z.string() }),
    execute: lookupOrder,
  },
  processRefund: {
    description: "Process a refund",
    inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
    execute: processRefund,
  },
};

// Per-turn step — streams one agent response into the durable writable.
async function runTurn(messages: ModelMessage[]) {
  "use step";

  const result = streamText({
    model: "anthropic/claude-haiku-4.5",
    system: "You are a customer support agent.",
    messages,
    tools: TOOLS,
    stopWhen: stepCountIs(8),
  });

  const writable = getWritable<UIMessageChunk>();
  // \`preventClose: true\` keeps the durable writable open so the next turn
  // can write to it. Each turn still emits its own start + finish chunks.
  await result.toUIMessageStream().pipeTo(writable, { preventClose: true });

  const response = await result.response;
  return { responseMessages: response.messages };
}

export async function supportWorkflow(initialMessages: ModelMessage[]) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  // Create the hook ONCE outside the loop. Re-creating it inside with the
  // same token throws \`HookConflictError\`. One hook, one token, reused
  // every iteration.
  const hook = turnHook.create({ token: workflowRunId });
  let allMessages = initialMessages;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { responseMessages } = await runTurn(allMessages);
    allMessages = [...allMessages, ...responseMessages];

    // Suspend until the next user message arrives.
    const { message } = await hook;
    if (message === "/done") break;

    allMessages = [...allMessages, { role: "user", content: message }];
  }

  return { turns: MAX_TURNS };
}
`;

export const aiSdkWorkflowInstallSource = `/**
 * AI SDK Integration — durable multi-turn conversation with streamText.
 *
 * THE PATTERN:
 *   1. One workflow run = one full conversation. The run stays alive across
 *      all turns; each new message is delivered via a hook resume().
 *   2. A per-turn "use step" function calls streamText() and pipes the
 *      result into the durable writable (preventClose: true keeps it open
 *      for the next turn). The entire turn is the atomic retry unit.
 *   3. The API route slices the run's stream from the current turn's start
 *      index so each HTTP response only contains that turn's chunks.
 *   4. MAX_TURNS caps the conversation; send "/done" to exit cleanly.
 *
 * USEFUL WHEN:
 *   - You want durable multi-turn conversations that survive restarts.
 *   - You want the raw AI SDK API (toUIMessageStream(), onChunk, etc.)
 *     rather than DurableAgent's wrapper.
 *   - The durability boundary should be an entire user turn — all tool
 *     calls inside a turn re-execute together on retry.
 *   - Users can reconnect mid-stream and receive the full response.
 *
 * CAVEAT — TOOLS ARE NOT INDIVIDUALLY DURABLE:
 *   streamText() invokes each tool's execute function inside the runTurn
 *   step. A "use step" directive on a tool body is a no-op when called from
 *   another step, so tools run as plain inline functions. If a later tool
 *   or model call throws, the whole turn retries and earlier tools run
 *   again. Make side-effectful tools idempotent (dedupe on a stable key),
 *   or use DurableAgent, which runs tools at workflow scope so each can be
 *   its own durable, retryable step.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace lookupOrder / processRefund with your domain tools.
 *   - Change "anthropic/claude-haiku-4.5" to any AI Gateway model string.
 *   - Adjust MAX_TURNS for your expected conversation length.
 *   - Change the system prompt in runTurn() to match your use case.
 *   - Tune stopWhen: stepCountIs(8) to cap the tool-calling loop per turn.
 *
 * DOCS: https://workflow-sdk.dev/patterns/ai-sdk
 */
import { streamText, stepCountIs } from "ai";
import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import type { ModelMessage, UIMessageChunk } from "ai";
import { z } from "zod";

const MAX_TURNS = 20;

// One hook per run drives the multi-turn loop. Each .resume() from the API
// route delivers the next user message to the suspended workflow.
export const turnHook = defineHook({
  schema: z.object({ message: z.string() }),
});

// streamText invokes tool executes inside runTurn (a step), so tool calls
// are not individually durable — the entire turn retries together. Make
// side-effectful tools idempotent (e.g. dedupe refunds on orderId), or use
// DurableAgent for per-tool durability.
async function lookupOrder({ orderId }: { orderId: string }) {
  const res = await fetch(\`https://api.store.com/orders/\${orderId}\`);
  return res.json();
}

async function processRefund({
  orderId,
  reason,
}: { orderId: string; reason: string }) {
  const res = await fetch("https://api.store.com/refunds", {
    method: "POST",
    body: JSON.stringify({ orderId, reason }),
  });
  return res.json();
}

const TOOLS = {
  lookupOrder: {
    description: "Look up an order by ID",
    inputSchema: z.object({ orderId: z.string() }),
    execute: lookupOrder,
  },
  processRefund: {
    description: "Process a refund",
    inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
    execute: processRefund,
  },
};

// Per-turn step — streams one LLM response into the durable writable.
// "use step" makes the entire turn the durability boundary: if the process
// restarts mid-stream, the whole turn (model + tools) re-executes together.
async function runTurn(messages: ModelMessage[]) {
  "use step";

  const result = streamText({
    model: "anthropic/claude-haiku-4.5",
    system: "You are a customer support agent.",
    messages,
    tools: TOOLS,
    stopWhen: stepCountIs(8),
  });

  // preventClose: true keeps the durable writable open across turns.
  // Each turn still emits its own start + finish chunks for slice detection.
  const writable = getWritable<UIMessageChunk>();
  await result.toUIMessageStream().pipeTo(writable, { preventClose: true });

  const response = await result.response;
  return { responseMessages: response.messages };
}

export async function supportWorkflow(initialMessages: ModelMessage[]) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  // Create the hook ONCE outside the loop. Re-creating inside with the same
  // token would throw HookConflictError. One hook, one token, reused every turn.
  const hook = turnHook.create({ token: workflowRunId });
  let allMessages = initialMessages;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { responseMessages } = await runTurn(allMessages);
    allMessages = [...allMessages, ...responseMessages];

    // Suspend here — the workflow parks until the next user message arrives.
    const { message } = await hook;
    if (message === "/done") break;

    allMessages = [...allMessages, { role: "user", content: message }];
  }

  return { turns: MAX_TURNS };
}
`;

export const aiSdkRouteSource = `import type { UIMessage, UIMessageChunk } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse } from "ai";
import { start, getRun } from "workflow/api";
import { supportWorkflow, turnHook } from "@/app/workflows/support";

// Pump the durable stream until this turn's \`finish\` chunk, then close
// the HTTP response. Release (don't cancel) the source reader so the
// workflow's durable stream keeps flowing for the next turn.
function sliceUntilFinish(
  source: ReadableStream<UIMessageChunk>
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          if (value.type === "finish") break;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

// \`/done\` exits the workflow without emitting chunks. Return a synthetic
// start+finish so \`useChat\`'s lifecycle terminates cleanly.
function emptyTurnStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start", messageId: crypto.randomUUID() });
      controller.enqueue({ type: "finish" });
      controller.close();
    },
  });
}

export async function POST(req: Request) {
  const { messages, runId }: { messages: UIMessage[]; runId?: string } =
    await req.json();
  const modelMessages = await convertToModelMessages(messages);

  // Follow-up turn: resume the hook, return only the new chunks.
  if (runId) {
    try {
      const run = getRun(runId);

      // Snapshot tail BEFORE resuming so the slice only contains this turn.
      const probe = run.getReadable();
      const tailIndex = await probe.getTailIndex();
      await probe.cancel();

      const lastUser = modelMessages.filter((m) => m.role === "user").at(-1);
      const text =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content
                .filter((p): p is { type: "text"; text: string } =>
                  "type" in p && p.type === "text"
                )
                .map((p) => p.text)
                .join("")
            : "";

      await turnHook.resume(runId, { message: text });

      if (text === "/done") {
        return createUIMessageStreamResponse({
          stream: emptyTurnStream(),
          headers: { "x-workflow-run-id": runId },
        });
      }

      const stream = sliceUntilFinish(
        run.getReadable({ startIndex: tailIndex + 1 })
      );

      return createUIMessageStreamResponse({
        stream,
        headers: { "x-workflow-run-id": runId },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      if (!msg.includes("not found") && !msg.includes("expired")) throw e;
      // Stale runId — fall through to start fresh.
    }
  }

  // First turn: start a new workflow.
  const run = await start(supportWorkflow, [modelMessages]);
  const stream = sliceUntilFinish(run.readable);

  return createUIMessageStreamResponse({
    stream,
    headers: { "x-workflow-run-id": run.runId },
  });
}
`;

export const aiSdkClientSource = `"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import { useMemo, useRef, useState } from "react";

// Stash the runId in a ref and forward it on every follow-up.
// \`WorkflowChatTransport\` handles the wiring for you.
export function SupportChat() {
  const [input, setInput] = useState("");
  const runIdRef = useRef<string | null>(null);

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: "/api/support",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, messages, runId: runIdRef.current },
        }),
        onChatSendMessage: (response) => {
          const id = response.headers.get("x-workflow-run-id");
          if (id) runIdRef.current = id;
        },
      }),
    []
  );

  const { messages, sendMessage, status } = useChat({ transport });
  const busy = status === "streaming" || status === "submitted";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !input.trim()) return;
        sendMessage({ text: input });
        setInput("");
      }}
    >
      {messages.map((m) => (
        <div key={m.id}>
          {m.role}:{" "}
          {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
        </div>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={busy}
      />
    </form>
  );
}
`;
