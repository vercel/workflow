/**
 * Source snippets for the Human-in-the-Loop registry entry.
 *
 * Drop-in pattern for pausing a `DurableAgent` until a human approves a
 * consequential action (booking, payment, irreversible delete, …) and then
 * resuming with the decision. Built on `defineHook()` keyed by the tool call
 * ID, with a custom data part streamed to the client so it can render
 * approval controls before the workflow suspends.
 *
 * Note on escaping: template literal placeholders inside the snippet (e.g.
 * `${runId}`) are escaped as `\${...}` so they stay literal here.
 */

export const humanInTheLoopWorkflowSource = `import { DurableAgent } from "@workflow/ai/agent";
import { defineHook, getWritable, sleep } from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// Hook keyed by the tool call ID — exported so the approval API route
// can resume it with the human's decision.
export const approvalHook = defineHook({
  schema: z.object({
    approved: z.boolean(),
    comment: z.string().optional(),
  }),
});

// Example tool that requires approval before it does anything irreversible.
// Replace the body with your real side effect (charge card, publish post,
// delete record, etc.).
async function performAction({ summary }: { summary: string }) {
  "use step";
  console.log("Performing approved action:", summary);
  return { ok: true, summary };
}

// Stream a custom data part BEFORE suspending so the client can render
// approval controls. Tool invocations don't stream until the tool returns,
// so without this the UI would have no way to show buttons.
async function emitApprovalRequest(details: {
  toolCallId: string;
  summary: string;
  payload: Record<string, unknown>;
}) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-approval-needed",
      id: details.toolCallId,
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

// Stream the resolution so the client can update the approval card.
async function emitApprovalResolved(details: {
  toolCallId: string;
  result: string;
}) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-approval-resolved",
      id: details.toolCallId,
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

// The approval tool. NOTE: no \`"use step"\` here — it uses workflow-level
// primitives (\`defineHook().create()\`, \`Promise.race\`, \`sleep()\`) and must
// run in the workflow context. Steps are called from within for the I/O.
async function requestApproval(
  { summary, payload }: {
    summary: string;
    payload: Record<string, unknown>;
  },
  { toolCallId }: { toolCallId: string },
) {
  // 1. Emit the approval request to the client BEFORE suspending.
  await emitApprovalRequest({ toolCallId, summary, payload });

  // 2. Suspend on the hook, with a durable timeout fallback.
  const hook = approvalHook.create({ token: toolCallId });
  const result = await Promise.race([
    hook.then((p) => ({ type: "decision" as const, ...p })),
    sleep("24h").then(() => ({
      type: "timeout" as const,
      approved: false as const,
    })),
  ]);

  // 3. Resolve based on the outcome.
  if (result.type === "timeout") {
    const msg = "Approval request expired.";
    await emitApprovalResolved({ toolCallId, result: msg });
    return msg;
  }
  if (!result.approved) {
    const msg = \`Rejected: \${result.comment || "No reason given"}\`;
    await emitApprovalResolved({ toolCallId, result: msg });
    return msg;
  }

  const action = await performAction({ summary });
  const msg = \`Approved and executed: \${action.summary}\`;
  await emitApprovalResolved({ toolCallId, result: msg });
  return msg;
}

export async function approvalAgent(messages: ModelMessage[]) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    instructions:
      "You are a careful assistant. ALWAYS call requestApproval before performing any consequential action.",
    tools: {
      requestApproval: {
        description:
          "Request human approval before performing a consequential action.",
        inputSchema: z.object({
          summary: z.string().describe("Short description of the action."),
          payload: z
            .record(z.string(), z.unknown())
            .describe(
              "Structured details rendered on the approval card — e.g. amount, recipient, etc.",
            ),
        }),
        execute: requestApproval,
      },
    },
  });

  const result = await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 15,
  });

  return { messages: result.messages };
}
`;

export const humanInTheLoopWorkflowInstallSource = `/**
 * Human-in-the-Loop — pause a DurableAgent for human approval.
 *
 * THE PATTERN:
 *   1. The agent calls requestApproval as a tool with a summary and payload.
 *   2. Before suspending, emit a "data-approval-needed" stream part so the
 *      client can render approval controls immediately — tool results don't
 *      stream until the tool returns, so this emit is the only way to show UI.
 *   3. Create an approvalHook keyed by toolCallId and await it, racing against
 *      a 24h sleep() timeout so the workflow never hangs forever.
 *   4. On approval/rejection, emit a "data-approval-resolved" part so the
 *      client can update the card, then execute the real side effect.
 *   5. The approval API route resumes the hook with { approved, comment }.
 *
 * USEFUL WHEN:
 *   - An agent action is irreversible or high-value (payment, delete, publish).
 *   - Compliance requires a human sign-off before automated side effects.
 *   - You want an audit trail of who approved what and when.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace performAction with your real side effect (Stripe charge, DB
 *     write, Slack post, etc.). It is a "use step" so it is durable.
 *   - Change the timeout duration in sleep("24h") to suit your SLA.
 *   - Add more fields to the approvalHook schema if you need structured
 *     reviewer notes beyond a simple boolean + comment.
 *   - Extend the ApprovalCard UI to display payload fields meaningfully
 *     (e.g. formatted amount, recipient name).
 *
 * DOCS: https://workflow-sdk.dev/patterns/human-in-the-loop
 */
import { DurableAgent } from "@workflow/ai/agent";
import { defineHook, getWritable, sleep } from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// Exported so the approval API route can resume with the human's decision.
export const approvalHook = defineHook({
  schema: z.object({
    approved: z.boolean(),
    comment: z.string().optional(),
  }),
});

// Real side effect — replace with your action (charge, publish, delete…).
// "use step" makes it durable: retried on failure, never re-run on replay.
async function performAction({ summary }: { summary: string }) {
  "use step";
  console.log("Performing approved action:", summary);
  return { ok: true, summary };
}

// Emit a custom stream part BEFORE suspending on the hook.
// Without this, the client has no way to show approval controls because
// tool invocations don't stream until the tool returns.
async function emitApprovalRequest(details: {
  toolCallId: string;
  summary: string;
  payload: Record<string, unknown>;
}) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-approval-needed",
      id: details.toolCallId,
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

// Emit a resolution part so the client can update the approval card to
// show the outcome (approved, rejected, or timed out).
async function emitApprovalResolved(details: {
  toolCallId: string;
  result: string;
}) {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-approval-resolved",
      id: details.toolCallId,
      data: details,
    } as UIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

// No "use step" here — requestApproval uses workflow-level primitives
// (hook.create, Promise.race, sleep) that must run in workflow context.
// The actual I/O (emit + perform) delegates to "use step" functions above.
async function requestApproval(
  { summary, payload }: {
    summary: string;
    payload: Record<string, unknown>;
  },
  { toolCallId }: { toolCallId: string },
) {
  // 1. Notify the client immediately before suspending.
  await emitApprovalRequest({ toolCallId, summary, payload });

  // 2. Suspend — the workflow pauses here until the reviewer responds or
  //    the timeout fires. The run stays alive in the Workflow backend.
  const hook = approvalHook.create({ token: toolCallId });
  const result = await Promise.race([
    hook.then((p) => ({ type: "decision" as const, ...p })),
    sleep("24h").then(() => ({ type: "timeout" as const, approved: false as const })),
  ]);

  // 3. Resolve based on outcome.
  if (result.type === "timeout") {
    const msg = "Approval request expired.";
    await emitApprovalResolved({ toolCallId, result: msg });
    return msg;
  }
  if (!result.approved) {
    const msg = \`Rejected: \${result.comment || "No reason given"}\`;
    await emitApprovalResolved({ toolCallId, result: msg });
    return msg;
  }

  const action = await performAction({ summary });
  const msg = \`Approved and executed: \${action.summary}\`;
  await emitApprovalResolved({ toolCallId, result: msg });
  return msg;
}

export async function approvalAgent(messages: ModelMessage[]) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    // Instruct the model to ALWAYS request approval before side effects.
    instructions:
      "You are a careful assistant. ALWAYS call requestApproval before performing any consequential action.",
    tools: {
      requestApproval: {
        description:
          "Request human approval before performing a consequential action.",
        inputSchema: z.object({
          summary: z.string().describe("Short description of the action."),
          payload: z
            .record(z.string(), z.unknown())
            .describe(
              "Structured details rendered on the approval card — e.g. amount, recipient, etc.",
            ),
        }),
        execute: requestApproval,
      },
    },
  });

  const result = await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 15,
  });

  return { messages: result.messages };
}
`;

export const humanInTheLoopStartRouteSource = `import type { UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { approvalAgent } from "@/app/workflows/human-in-the-loop";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const modelMessages = await convertToModelMessages(messages);

  const run = await start(approvalAgent, [modelMessages]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: { "x-workflow-run-id": run.runId },
  });
}
`;

export const humanInTheLoopRouteSource = `import { NextResponse } from "next/server";
import { approvalHook } from "@/app/workflows/human-in-the-loop";

export async function POST(req: Request) {
  const { toolCallId, approved, comment } = (await req.json()) as {
    toolCallId: string;
    approved: boolean;
    comment?: string;
  };

  if (!toolCallId || typeof approved !== "boolean") {
    return NextResponse.json(
      { error: "toolCallId and approved are required" },
      { status: 400 },
    );
  }

  try {
    await approvalHook.resume(toolCallId, { approved, comment });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (msg.includes("not found") || msg.includes("expired")) {
      return NextResponse.json(
        { success: true, note: "No active approval for that toolCallId." },
      );
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}
`;

export const humanInTheLoopCardSource = `"use client";

import type { UIMessage } from "ai";

interface ApprovalNeededPart {
  type: "data-approval-needed";
  id: string;
  data: {
    toolCallId: string;
    summary: string;
    payload: Record<string, unknown>;
  };
}

interface ApprovalResolvedPart {
  type: "data-approval-resolved";
  id: string;
  data: { toolCallId: string; result: string };
}

interface ApprovalCardProps {
  /** The \`data-approval-needed\` part from the message stream. */
  part: ApprovalNeededPart;
  /** All messages in the conversation, used to detect resolution. */
  messages: UIMessage[];
  /** Endpoint that resumes the approval hook. */
  endpoint?: string;
}

export function ApprovalCard({
  part,
  messages,
  endpoint = "/api/approval",
}: ApprovalCardProps) {
  const { toolCallId, summary, payload } = part.data;

  // If we already streamed a resolution for this toolCallId, render it.
  const resolved = messages
    .flatMap((m) => m.parts ?? [])
    .find(
      (p): p is ApprovalResolvedPart =>
        p.type === "data-approval-resolved" &&
        (p as ApprovalResolvedPart).data.toolCallId === toolCallId,
    );

  if (resolved) {
    return (
      <div className="rounded-lg border bg-muted/40 p-4 text-sm">
        {resolved.data.result}
      </div>
    );
  }

  const respond = async (approved: boolean, comment?: string) => {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolCallId, approved, comment }),
    });
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="text-sm font-medium">{summary}</div>
      <pre className="text-xs bg-muted/40 rounded p-2 overflow-x-auto">
        {JSON.stringify(payload, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          className="px-3 py-1.5 text-sm rounded-md bg-foreground text-background"
          onClick={() => respond(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm rounded-md border"
          onClick={() => respond(false, "Rejected by reviewer")}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
`;

export const humanInTheLoopUsageSource = `// In your chat client (\`useChat()\`-based), render the ApprovalCard for any
// \`data-approval-needed\` part and hide the underlying tool invocation:
import { ApprovalCard } from "@/components/approval-card";

function MessageParts({ message, messages }) {
  return message.parts?.map((part, i) => {
    if (part.type === "data-approval-needed") {
      return (
        <ApprovalCard
          key={i}
          part={part}
          messages={messages}
          endpoint="/api/approval"
        />
      );
    }
    // The approval tool itself doesn't have a useful UI representation —
    // the card handles it.
    if (
      part.type === "tool-invocation" &&
      part.toolInvocation.toolName === "requestApproval"
    ) {
      return null;
    }
    if (part.type === "text") return <p key={i}>{part.text}</p>;
    return null;
  });
}
`;
