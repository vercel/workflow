/**
 * Source snippets for the Agent Cancellation registry entry.
 *
 * Drop-in cancellation pattern for any `DurableAgent`. The workflow races the
 * agent against a `stopHook` keyed by the run ID; when the user clicks the
 * Stop button, the route resumes the hook and the workflow exits cleanly,
 * emitting a final `data-stopped` part to the stream so the client renders a
 * clean ending. Falls back to `getRun(runId).cancel()` if the hook is already
 * gone.
 *
 * IMPORTANT: this pattern does NOT cancel the underlying model stream.
 * Tokens generated after the stop signal are still produced (and billed).
 * What it DOES is exit the workflow function as soon as the hook fires and
 * notify the client. For hard cross-process cancellation that signals the
 * inner step to bail out, see the Distributed Abort Controller cookbook.
 */

export const agentCancellationWorkflowSource = `import { DurableAgent } from "@workflow/ai/agent";
import {
  defineHook,
  getWorkflowMetadata,
  getWritable,
} from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// Hook resumed by the stop API route.
export const stopHook = defineHook({
  schema: z.object({ reason: z.string().optional() }),
});

// Replace these with your real tools.
async function searchWeb({ query }: { query: string }) {
  "use step";
  await new Promise((r) => setTimeout(r, 1500));
  return {
    results: [{ title: \`\${query} — overview\`, snippet: \`Result for \${query}.\` }],
  };
}

async function emitStopSignal(details: { reason?: string }) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-stopped",
      id: "stop-signal",
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

export async function stoppableAgent(messages: ModelMessage[]) {
  "use workflow";

  // Token derived from the run ID so the stop API can resume by runId
  // alone — no extra bookkeeping required.
  const { workflowRunId } = getWorkflowMetadata();
  const hook = stopHook.create({ token: \`stop:\${workflowRunId}\` });

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    instructions: "You are a research assistant. Search and summarize as needed.",
    tools: {
      searchWeb: {
        description: "Search the web for information",
        inputSchema: z.object({ query: z.string() }),
        execute: searchWeb,
      },
    },
  });

  // Race the agent against the stop hook. When the hook fires, the workflow
  // exits at its next \`await\` boundary; the underlying model stream may keep
  // generating tokens in the background.
  const result = await Promise.race([
    agent
      .stream({
        messages,
        writable: getWritable<UIMessageChunk>(),
        maxSteps: 15,
      })
      .then((r) => ({ type: "complete" as const, messages: r.messages })),
    hook.then(({ reason }) => ({ type: "stopped" as const, reason })),
  ]);

  // Emit a final stream part on stop so the client renders a clean ending.
  if (result.type === "stopped") {
    await emitStopSignal({ reason: result.reason });
  }

  return result;
}
`;

export const agentCancellationWorkflowInstallSource = `/**
 * Agent Cancellation — graceful Stop Signal for any DurableAgent.
 *
 * THE PATTERN:
 *   1. Create a stopHook token = runId so the stop API can resume it with
 *      just the runId — no extra bookkeeping required.
 *   2. Race the agent's .stream() against the hook. Whichever resolves first
 *      wins; the workflow exits at its next await boundary.
 *   3. On stop, emit a "data-stopped" stream part so the client renders a
 *      clean ending instead of an abrupt connection close.
 *   4. The stop API route tries the hook first; falls back to getRun().cancel()
 *      if the hook is already consumed (agent finished mid-request).
 *
 * USEFUL WHEN:
 *   - You need a "Stop" button in a chat UI backed by a streaming agent.
 *   - The agent should finish its current sentence before exiting (graceful).
 *   - You want the client to display a tidy "stopped" indicator instead of
 *     a raw connection drop.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the searchWeb tool with your real tools. The surrounding
 *     race/hook shape is domain-agnostic.
 *   - Change maxSteps to match your budget — 15 is a safe default.
 *   - Adjust the "data-stopped" part payload if your client needs richer info.
 *   - For hard cross-process cancellation (kills the model stream too), see
 *     the Distributed Abort Controller pattern instead.
 *
 * NOTE: Stop Signal does NOT cancel the underlying model stream. Tokens
 * generated after the stop hook fires are still produced (and billed). The
 * workflow exits and notifies the client, but the inference keeps running.
 *
 * DOCS: https://workflow-sdk.dev/patterns/agent-cancellation
 */
import { DurableAgent } from "@workflow/ai/agent";
import {
  defineHook,
  getWorkflowMetadata,
  getWritable,
} from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// Hook resumed by the stop API route.
export const stopHook = defineHook({
  schema: z.object({ reason: z.string().optional() }),
});

// Replace these with your real tools.
async function searchWeb({ query }: { query: string }) {
  "use step";
  await new Promise((r) => setTimeout(r, 1500));
  return {
    results: [{ title: \`\${query} — overview\`, snippet: \`Result for \${query}.\` }],
  };
}

async function emitStopSignal(details: { reason?: string }) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-stopped",
      id: "stop-signal",
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

export async function stoppableAgent(messages: ModelMessage[]) {
  "use workflow";

  // Token = runId so any process can resume the stop hook with just the runId.
  const { workflowRunId } = getWorkflowMetadata();
  const hook = stopHook.create({ token: \`stop:\${workflowRunId}\` });

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    instructions: "You are a research assistant. Search and summarize as needed.",
    tools: {
      searchWeb: {
        description: "Search the web for information",
        inputSchema: z.object({ query: z.string() }),
        execute: searchWeb,
      },
    },
  });

  // Race: whichever resolves first wins. The model stream may keep running
  // after the hook fires — see NOTE above.
  const result = await Promise.race([
    agent
      .stream({
        messages,
        writable: getWritable<UIMessageChunk>(),
        maxSteps: 15,
      })
      .then((r) => ({ type: "complete" as const, messages: r.messages })),
    hook.then(({ reason }) => ({ type: "stopped" as const, reason })),
  ]);

  // Notify the client with a clean "stopped" part instead of a silent drop.
  if (result.type === "stopped") {
    await emitStopSignal({ reason: result.reason });
  }

  return result;
}
`;

export const agentCancellationStartRouteSource = `import type { UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { stoppableAgent } from "@/app/workflows/agent-cancellation";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const modelMessages = await convertToModelMessages(messages);

  const run = await start(stoppableAgent, [modelMessages]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: { "x-workflow-run-id": run.runId },
  });
}
`;

export const agentCancellationRouteSource = `import { getRun } from "workflow/api";
import { NextResponse } from "next/server";
import { stopHook } from "@/app/workflows/agent-cancellation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const { reason } = (await req.json().catch(() => ({}))) as {
    reason?: string;
  };

  // Try the graceful Stop Signal first.
  try {
    await stopHook.resume(\`stop:\${runId}\`, {
      reason: reason ?? "User requested stop",
    });
    return NextResponse.json({ success: true, mode: "stop-signal" });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (!msg.includes("not found") && !msg.includes("expired")) {
      throw error;
    }
    // Hook already consumed (e.g. agent finished, race resolved). Fall back
    // to hard cancel so the run is definitely terminated.
    try {
      await getRun(runId).cancel();
    } catch {
      // Run already in a terminal state — nothing to do.
    }
    return NextResponse.json({ success: true, mode: "hard-cancel" });
  }
}
`;

export const agentCancellationButtonSource = `"use client";

import { useState } from "react";

interface StopButtonProps {
  /** Active workflow run ID (forwarded from \`x-workflow-run-id\` header). */
  runId: string | null | undefined;
  /** Endpoint pattern; \`{runId}\` will be substituted. */
  endpoint?: string;
  /** Optional className override. */
  className?: string;
}

export function StopButton({
  runId,
  endpoint = "/api/agent/{runId}/stop",
  className,
}: StopButtonProps) {
  const [stopping, setStopping] = useState(false);

  if (!runId) return null;

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch(endpoint.replace("{runId}", runId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User clicked stop" }),
      });
    } finally {
      setStopping(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleStop}
      disabled={stopping}
      className={
        className ??
        "px-3 py-1.5 text-sm rounded-md border hover:bg-muted disabled:opacity-50"
      }
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}
`;

// ─── Concept snippets ─────────────────────────────────────────────────────────
// Simplified educational code for patterns that differ meaningfully from
// the plug-and-play install. These appear in the "Concept" section and are
// NOT installed by the shadcn CLI.

export const agentCancellationConceptHardCancelSource = `import { getRun } from "workflow/api";

// Hard Cancellation — terminates the run immediately.
// No cleanup runs, no final stream notification, no return value.
// Use when the run is stuck or you just need it gone.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  await getRun(runId).cancel();
  return Response.json({ success: true });
}
`;

export const agentCancellationConceptStopSignalSource = `import { DurableAgent } from "@workflow/ai/agent";
import { defineHook, getWorkflowMetadata, getWritable } from "workflow";
import type { ModelMessage, UIMessageChunk } from "ai";

// Stop Signal — exits cleanly at the next await boundary, runs cleanup,
// and emits a final stream part so the client renders a tidy ending.
export const stopHook = defineHook<{ reason?: string }>();

export async function stoppableAgent(messages: ModelMessage[]) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  // Hook token is scoped to this run — any process can resume it with just runId.
  const hook = stopHook.create({ token: \`stop:\${workflowRunId}\` });

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    instructions: "You are a research assistant.",
    tools: { /* your tools here */ },
  });

  // Race: whichever resolves first wins — the agent finishing or the stop hook.
  const result = await Promise.race([
    agent
      .stream({ messages, writable: getWritable<UIMessageChunk>(), maxSteps: 15 })
      .then((r) => ({ type: "complete" as const, messages: r.messages })),
    hook.then(({ reason }) => ({ type: "stopped" as const, reason })),
  ]);

  // Emit a final stream part so the client knows it was stopped, not dropped.
  if (result.type === "stopped") {
    const writer = getWritable<UIMessageChunk>().getWriter();
    try {
      await writer.write({ type: "data-stopped", id: "stop", data: { reason: result.reason } } as UIMessageChunk);
    } finally {
      writer.releaseLock();
    }
  }

  return result;
}
`;

export const agentCancellationConceptStopRouteSource = `import { stopHook } from "@/app/workflows/agent-cancellation";

// POST /api/agent/[runId]/stop — resumes the hook to trigger a graceful exit.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const { reason } = await request.json().catch(() => ({}));
  await stopHook.resume(\`stop:\${runId}\`, { reason: reason ?? "User requested stop" });
  return Response.json({ success: true });
}
`;

export const agentCancellationUsageSource = `// In your chat client, capture the runId from the response header on the
// FIRST message and render the Stop button while the agent is streaming:
"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";
import { StopButton } from "@/components/stop-button";

export function Chat() {
  const [runId, setRunId] = useState<string | null>(null);

  const { messages, sendMessage, status } = useChat({
    api: "/api/agent",
    onResponse(res) {
      const id = res.headers.get("x-workflow-run-id");
      if (id) setRunId(id);
    },
  });

  return (
    <div>
      {/* Render messages, including a "stopped" line if you see a
          \`data-stopped\` part. */}
      {messages.map((m) => (
        <div key={m.id}>{/* render parts */}</div>
      ))}

      {/* Show Stop only while the agent is actively streaming. */}
      {status === "streaming" && (
        <StopButton runId={runId} endpoint="/api/agent/{runId}/stop" />
      )}
    </div>
  );
}
`;
