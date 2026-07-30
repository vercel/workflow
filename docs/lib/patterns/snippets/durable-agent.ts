/**
 * Source snippets for the Durable Agent registry entry.
 *
 * The foundational AI agent pattern on Workflow: a `DurableAgent` whose tools
 * are `"use step"` functions, streamed to the client via `getWritable()`. If
 * the process crashes mid-tool-call, the agent resumes from the last completed
 * step on replay — every retry, replay, and reconnect is handled by the
 * runtime, no extra bookkeeping in your code.
 *
 * The example uses a flight booking agent because it's the simplest case that
 * exercises every aspect of the pattern (multi-tool, multi-turn, side-effecty
 * external API calls). Replace the tools with your own — the surrounding
 * shape stays identical.
 *
 * NOTE: `DurableAgent` is deprecated in Workflow SDK v5 — new durable agent
 * work on v5 should use AI SDK v7's `WorkflowAgent`, which implements the
 * same pattern from the AI SDK package. This pattern remains valid for v4
 * and existing `DurableAgent` code.
 *
 * Note on escaping: template literal placeholders inside the snippet (e.g.
 * `${runId}`) are escaped as `\${...}` so they stay literal here.
 */

export const durableAgentWorkflowSource = `import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// Each tool is a regular async function with \`"use step"\` at the top.
// That single directive turns it into a durable step:
//   - automatic retries on failure (3x by default)
//   - one entry per call in the workflow event log
//   - full Node.js access (fetch, fs, child_process, native modules, …)
//   - re-entrant: replays return the recorded result instead of re-running
async function searchFlights({ from, to, date }: {
  from: string;
  to: string;
  date: string;
}) {
  "use step";
  const res = await fetch(
    \`https://api.example.com/flights?from=\${from}&to=\${to}&date=\${date}\`,
  );
  if (!res.ok) throw new Error(\`Search failed: \${res.status}\`);
  return res.json();
}

async function bookFlight({ flightId, passenger }: {
  flightId: string;
  passenger: string;
}) {
  "use step";
  const res = await fetch("https://api.example.com/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flightId, passenger }),
  });
  if (!res.ok) throw new Error(\`Booking failed: \${res.status}\`);
  return res.json();
}

async function checkWeather({ city }: { city: string }) {
  "use step";
  const res = await fetch(
    \`https://api.weather.com/forecast?city=\${city}\`,
  );
  return res.json();
}

// The agent itself is a workflow. \`"use workflow"\` declares it as the
// orchestrator — its execution is replay-safe and persisted to the event log.
// Each \`agent.stream()\` call drives the LLM loop; tools fire as steps.
export async function flightAgent(messages: ModelMessage[]) {
  "use workflow";

  const agent = new DurableAgent({
    // Any AI Gateway model string works — swap providers without touching
    // the durability layer.
    model: "anthropic/claude-haiku-4.5",
    instructions: "You are a helpful flight booking assistant.",
    tools: {
      searchFlights: {
        description: "Search for available flights between two airports.",
        inputSchema: z.object({
          from: z.string().describe("Departure airport code"),
          to: z.string().describe("Arrival airport code"),
          date: z.string().describe("Travel date (YYYY-MM-DD)"),
        }),
        execute: searchFlights,
      },
      bookFlight: {
        description: "Book a specific flight for a passenger.",
        inputSchema: z.object({
          flightId: z.string().describe("Flight ID from search results"),
          passenger: z.string().describe("Passenger full name"),
        }),
        execute: bookFlight,
      },
      checkWeather: {
        description: "Check the weather forecast for a city.",
        inputSchema: z.object({
          city: z.string().describe("City name"),
        }),
        execute: checkWeather,
      },
    },
  });

  // \`getWritable<UIMessageChunk>()\` streams text chunks, tool calls, and tool
  // results to the client in real time via \`createUIMessageStreamResponse\`.
  // \`maxSteps\` caps the LLM loop so a runaway tool-calling agent can't burn
  // through your budget — tune for your use case.
  const result = await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 10,
  });

  // Return the final messages so multi-turn callers can pass them back in.
  return { messages: result.messages };
}
`;

export const durableAgentWorkflowInstallSource = `/**
 * Durable Agent — crash-safe AI agent with durable tool execution.
 *
 * THE PATTERN:
 *   1. Each tool is a "use step" function — the runtime persists its input
 *      before calling it and replays the recorded result on restart.
 *   2. The agent workflow ("use workflow") drives the LLM loop via
 *      DurableAgent.stream(). If the process crashes mid-tool-call, it
 *      resumes from the last completed step on the next invocation.
 *   3. getWritable<UIMessageChunk>() streams text, tool calls, and results
 *      to the client in real time. The stream is durable — clients can
 *      reconnect and resume from any offset.
 *
 * USEFUL WHEN:
 *   - Your agent calls external APIs with side effects (bookings, payments)
 *     and you can't afford to re-run them on failure.
 *   - Tool calls are slow (seconds) and you want retry without duplicates.
 *   - You need multi-turn conversation state to survive server restarts.
 *   - You're building a chat UI where users can reconnect mid-generation.
 *
 * DEPRECATION NOTE:
 *   DurableAgent is deprecated in Workflow SDK v5. For new durable agent
 *   work on v5, use AI SDK v7's WorkflowAgent — same pattern, lives in the
 *   AI SDK package: https://ai-sdk.dev/v7/docs/agents/workflow-agent
 *   This file remains valid for v4 and existing DurableAgent code.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace searchFlights / bookFlight / checkWeather with your tools.
 *     Every "use step" function gets the same durability guarantees.
 *   - Swap "anthropic/claude-haiku-4.5" for any AI Gateway model string
 *     (openai/gpt-4o, google/gemini-2.0-flash, etc.).
 *   - Tune maxSteps to match your agent's expected tool-call depth.
 *   - Add a stopHook race (see Agent Cancellation pattern) for a Stop button.
 *   - For human-in-the-loop approval gates, see the Human-in-the-Loop pattern.
 *
 * DOCS: https://workflow-sdk.dev/patterns/durable-agent
 */
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";

// "use step" turns any async function into a durable step:
//   - automatic retries on failure (3x by default, configurable via .maxRetries)
//   - one entry per call in the workflow event log
//   - full Node.js access (fetch, fs, child_process, native modules, …)
//   - replay-safe: re-runs return the recorded result without re-executing
async function searchFlights({ from, to, date }: {
  from: string;
  to: string;
  date: string;
}) {
  "use step";
  const res = await fetch(
    \`https://api.example.com/flights?from=\${from}&to=\${to}&date=\${date}\`,
  );
  if (!res.ok) throw new Error(\`Search failed: \${res.status}\`);
  return res.json();
}

async function bookFlight({ flightId, passenger }: {
  flightId: string;
  passenger: string;
}) {
  "use step";
  const res = await fetch("https://api.example.com/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flightId, passenger }),
  });
  if (!res.ok) throw new Error(\`Booking failed: \${res.status}\`);
  return res.json();
}

async function checkWeather({ city }: { city: string }) {
  "use step";
  const res = await fetch(\`https://api.weather.com/forecast?city=\${city}\`);
  return res.json();
}

// "use workflow" declares the orchestrator — its execution is replay-safe
// and persisted to the event log. Each agent.stream() call drives the LLM
// loop; tools fire as durable steps.
export async function flightAgent(messages: ModelMessage[]) {
  "use workflow";

  const agent = new DurableAgent({
    // Any AI Gateway model string works — swap providers without touching
    // the durability layer.
    model: "anthropic/claude-haiku-4.5",
    instructions: "You are a helpful flight booking assistant.",
    tools: {
      searchFlights: {
        description: "Search for available flights between two airports.",
        inputSchema: z.object({
          from: z.string().describe("Departure airport code"),
          to: z.string().describe("Arrival airport code"),
          date: z.string().describe("Travel date (YYYY-MM-DD)"),
        }),
        execute: searchFlights,
      },
      bookFlight: {
        description: "Book a specific flight for a passenger.",
        inputSchema: z.object({
          flightId: z.string().describe("Flight ID from search results"),
          passenger: z.string().describe("Passenger full name"),
        }),
        execute: bookFlight,
      },
      checkWeather: {
        description: "Check the weather forecast for a city.",
        inputSchema: z.object({ city: z.string().describe("City name") }),
        execute: checkWeather,
      },
    },
  });

  // getWritable() streams chunks to the client in real time.
  // maxSteps caps the LLM loop — tune for your agent's expected depth.
  const result = await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 10,
  });

  // Return final messages so multi-turn callers can pass them back in.
  return { messages: result.messages };
}
`;

export const durableAgentStartRouteSource = `import type { UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { flightAgent } from "@/app/workflows/durable-agent";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  // The client sends \`UIMessage\`s; the agent works on \`ModelMessage\`s. This
  // converts in-place — no information is lost.
  const modelMessages = await convertToModelMessages(messages);

  // \`start()\` kicks off a new workflow run and returns a readable stream of
  // UI message chunks plus the run ID. The client should keep that ID around
  // so it can reconnect (\`useChat()\`'s WorkflowChatTransport handles this
  // automatically).
  const run = await start(flightAgent, [modelMessages]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: { "x-workflow-run-id": run.runId },
  });
}
`;

export const durableAgentClientSource = `"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";

/**
 * Minimal flight-agent chat UI. \`WorkflowChatTransport\` forwards the
 * \`x-workflow-run-id\` header between turns so multi-turn conversations land
 * on the same workflow run — and reconnect cleanly across page refreshes.
 */
export function FlightAgentChat() {
  const { messages, sendMessage, status } = useChat({
    transport: new WorkflowChatTransport({ api: "/api/flight-agent" }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-3">
        {messages.map((message) => (
          <div key={message.id} className="text-sm">
            <strong>{message.role === "user" ? "You" : "Agent"}:</strong>{" "}
            {message.parts?.map((part, i) =>
              part.type === "text" ? <span key={i}>{part.text}</span> : null,
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const input = (e.currentTarget.elements.namedItem(
            "message",
          ) as HTMLInputElement).value;
          if (!input) return;
          (e.currentTarget as HTMLFormElement).reset();
          await sendMessage({ text: input });
        }}
      >
        <input
          name="message"
          placeholder="Find flights from SFO to JFK on 2026-06-01"
          className="w-full rounded-md border px-3 py-2 text-sm"
          disabled={status === "streaming"}
        />
      </form>
    </div>
  );
}
`;
