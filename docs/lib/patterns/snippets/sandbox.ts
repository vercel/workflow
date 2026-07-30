/**
 * Source snippets for the Vercel Sandbox registry entry.
 *
 * Each export is a raw string of source code that the detail page renders
 * with shiki. The canonical reference for these snippets is the Sandbox
 * cookbook integration — `content/docs/cookbook/integrations/sandbox.mdx`.
 *
 * The pattern: one workflow run = one persistent sandbox session. The
 * workflow races a command hook against `sleep()` timers — when idle, it
 * snapshots and hibernates indefinitely; near the sandbox hard cap, it
 * snapshots and immediately recreates so the logical session outlives any
 * one VM. Exit is via an explicit `/destroy` command.
 *
 * Note on escaping: template literal placeholders inside the snippet are
 * escaped as `\${...}` so they stay literal here.
 */

export const sandboxWorkflowSource = `import { defineHook, sleep, getWritable, getWorkflowMetadata } from "workflow";
import { Sandbox, type Snapshot } from "@vercel/sandbox";
import { z } from "zod";

export const commandHook = defineHook({
  schema: z.object({ command: z.string() }),
});

const RUNTIME = "node22";
const HIBERNATE_AFTER_MS = 30 * 60_000; // 30 min idle → hibernate
const SANDBOX_TIMEOUT_MS = 5 * 60 * 60_000; // sandbox hard cap (5h)
const REFRESH_SAFETY_MS = 5 * 60_000; // refresh 5 min before the cap

export type SandboxEvent =
  | {
      type: "created";
      sandboxId: string;
      runtime: string;
      startedAt: number;
      sandboxExpiresAt: number;
      hibernateAfterMs: number;
    }
  | {
      type: "status";
      state:
        | "active"
        | "hibernating"
        | "hibernated"
        | "resuming"
        | "refreshing"
        | "destroyed";
      at: number;
      sandboxId?: string;
      sandboxExpiresAt?: number;
      snapshotId?: string;
    }
  | { type: "activity"; at: number }
  | { type: "command_start"; id: string; command: string; at: number }
  | { type: "command_output"; id: string; stream: "stdout" | "stderr"; data: string }
  | { type: "command_end"; id: string; exitCode: number | null; durationMs: number }
  | { type: "result"; status: "destroyed"; durationMs: number };

async function emit(event: SandboxEvent) {
  "use step";
  const writer = getWritable<SandboxEvent>().getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

async function runCommandAndStream(
  sandbox: Sandbox,
  id: string,
  command: string
) {
  "use step";
  const writer = getWritable<SandboxEvent>().getWriter();
  const startedAt = Date.now();
  try {
    await writer.write({ type: "command_start", id, command, at: startedAt });
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", command],
    });
    const stdout = await result.stdout();
    if (stdout) {
      await writer.write({ type: "command_output", id, stream: "stdout", data: stdout });
    }
    const stderr = await result.stderr();
    if (stderr) {
      await writer.write({ type: "command_output", id, stream: "stderr", data: stderr });
    }
    await writer.write({
      type: "command_end",
      id,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    writer.releaseLock();
  }
}

export async function sandboxSessionWorkflow() {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  // Create the hook ONCE outside the loop. Re-creating it inside with the
  // same token throws \`HookConflictError\`. One hook, one token, reused
  // every iteration.
  const hook = commandHook.create({ token: workflowRunId });

  const startedAt = Date.now();

  let sandbox: Sandbox = await Sandbox.create({
    runtime: RUNTIME,
    timeout: SANDBOX_TIMEOUT_MS,
  });
  let sandboxCreatedAt = Date.now();
  let sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;

  await emit({
    type: "created",
    sandboxId: sandbox.name,
    runtime: RUNTIME,
    startedAt,
    sandboxExpiresAt,
    hibernateAfterMs: HIBERNATE_AFTER_MS,
  });
  await emit({
    type: "status",
    state: "active",
    at: Date.now(),
    sandboxId: sandbox.name,
    sandboxExpiresAt,
  });

  let snapshot: Snapshot | null = null;
  let hibernated = false;
  let lastActivityAt = startedAt;
  let counter = 0;
  let destroyed = false;

  try {
    while (!destroyed) {
      if (hibernated && snapshot) {
        // VM already stopped. Wait for the next command — no idle timer,
        // no compute cost.
        const payload = await hook;
        if (payload.command === "/destroy") {
          destroyed = true;
          break;
        }

        await emit({ type: "status", state: "resuming", at: Date.now() });
        sandbox = await Sandbox.create({
          source: { type: "snapshot", snapshotId: snapshot.snapshotId },
          timeout: SANDBOX_TIMEOUT_MS,
        });
        sandboxCreatedAt = Date.now();
        sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;
        hibernated = false;
        snapshot = null;
        await emit({
          type: "status",
          state: "active",
          at: Date.now(),
          sandboxId: sandbox.name,
          sandboxExpiresAt,
        });

        counter += 1;
        await runCommandAndStream(sandbox, \`cmd-\${counter}\`, payload.command);
        lastActivityAt = Date.now();
        await emit({ type: "activity", at: lastActivityAt });
        continue;
      }

      // Active — wake at whichever comes first: idle deadline or refresh.
      const idleDeadline = lastActivityAt + HIBERNATE_AFTER_MS;
      const refreshDeadline = sandboxExpiresAt - REFRESH_SAFETY_MS;
      const wakeAt = Math.min(idleDeadline, refreshDeadline);
      const sleepMs = Math.max(0, wakeAt - Date.now());

      const outcome = await Promise.race([
        hook.then((p) => ({ type: "command" as const, command: p.command })),
        sleep(\`\${sleepMs}ms\`).then(() => ({ type: "timer" as const })),
      ]);

      if (outcome.type === "timer") {
        const nearExpiry = Date.now() >= refreshDeadline;

        if (nearExpiry) {
          // Proactive refresh — snapshot + immediately recreate so the
          // session outlives the sandbox hard cap.
          await emit({ type: "status", state: "refreshing", at: Date.now() });
          const snap = await sandbox.snapshot();
          sandbox = await Sandbox.create({
            source: { type: "snapshot", snapshotId: snap.snapshotId },
            timeout: SANDBOX_TIMEOUT_MS,
          });
          sandboxCreatedAt = Date.now();
          sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;
          await emit({
            type: "status",
            state: "active",
            at: Date.now(),
            sandboxId: sandbox.name,
            sandboxExpiresAt,
            snapshotId: snap.snapshotId,
          });
          lastActivityAt = Date.now();
        } else {
          // Idle — snapshot and hibernate indefinitely.
          await emit({ type: "status", state: "hibernating", at: Date.now() });
          snapshot = await sandbox.snapshot();
          hibernated = true;
          await emit({
            type: "status",
            state: "hibernated",
            at: Date.now(),
            snapshotId: snapshot.snapshotId,
          });
        }
        continue;
      }

      if (outcome.command === "/destroy") {
        destroyed = true;
        break;
      }

      counter += 1;
      await runCommandAndStream(sandbox, \`cmd-\${counter}\`, outcome.command);
      lastActivityAt = Date.now();
      await emit({ type: "activity", at: lastActivityAt });
    }
  } finally {
    if (!hibernated) {
      try {
        if (sandbox.status === "running") await sandbox.stop();
      } catch {
        /* best-effort */
      }
    }
    await emit({ type: "status", state: "destroyed", at: Date.now() });
    await emit({
      type: "result",
      status: "destroyed",
      durationMs: Date.now() - startedAt,
    });
  }
}
`;

export const sandboxWorkflowInstallSource = `/**
 * Vercel Sandbox — persistent interactive sandbox session with auto-hibernate.
 *
 * THE PATTERN:
 *   1. One workflow run = one logical sandbox session. The workflow manages
 *      the VM lifecycle: create → run commands → hibernate idle → resume
 *      → refresh near hard cap → destroy on explicit command.
 *   2. A commandHook (token = runId) receives commands from the API route,
 *      created once outside the loop and reused every iteration.
 *   3. When idle, the workflow snapshots the sandbox and hibernates (zero
 *      compute cost). On the next command, it resumes from the snapshot.
 *   4. Before the sandbox hard cap, the workflow proactively snapshots and
 *      recreates so the logical session outlives any one VM.
 *
 * USEFUL WHEN:
 *   - You need an interactive coding environment that survives page refreshes.
 *   - You want the sandbox to hibernate when idle without losing state.
 *   - Sessions should persist across multiple browser tabs or reconnections.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Tune HIBERNATE_AFTER_MS (default 30 min) for your idle tolerance.
 *   - Tune SANDBOX_TIMEOUT_MS (default 5h) to match your hard cap.
 *   - Change RUNTIME to "python3.13", "node22", etc. as needed.
 *   - Add custom event types to SandboxEvent for richer client UI.
 *   - For one-shot pipelines (no interactivity), use the simpler
 *     sandboxPipeline pattern in the Usage snippet instead.
 *
 * DOCS: https://workflow-sdk.dev/patterns/sandbox
 */
import { defineHook, sleep, getWritable, getWorkflowMetadata } from "workflow";
import { Sandbox, type Snapshot } from "@vercel/sandbox";
import { z } from "zod";

export const commandHook = defineHook({
  schema: z.object({ command: z.string() }),
});

const RUNTIME = "node22";
const HIBERNATE_AFTER_MS = 30 * 60_000; // 30 min idle → hibernate
const SANDBOX_TIMEOUT_MS = 5 * 60 * 60_000; // sandbox hard cap (5h)
const REFRESH_SAFETY_MS = 5 * 60_000; // refresh 5 min before the cap

export type SandboxEvent =
  | {
      type: "created";
      sandboxId: string;
      runtime: string;
      startedAt: number;
      sandboxExpiresAt: number;
      hibernateAfterMs: number;
    }
  | {
      type: "status";
      state:
        | "active"
        | "hibernating"
        | "hibernated"
        | "resuming"
        | "refreshing"
        | "destroyed";
      at: number;
      sandboxId?: string;
      sandboxExpiresAt?: number;
      snapshotId?: string;
    }
  | { type: "activity"; at: number }
  | { type: "command_start"; id: string; command: string; at: number }
  | { type: "command_output"; id: string; stream: "stdout" | "stderr"; data: string }
  | { type: "command_end"; id: string; exitCode: number | null; durationMs: number }
  | { type: "result"; status: "destroyed"; durationMs: number };

async function emit(event: SandboxEvent) {
  "use step";
  const writer = getWritable<SandboxEvent>().getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

async function runCommandAndStream(sandbox: Sandbox, id: string, command: string) {
  "use step";
  const writer = getWritable<SandboxEvent>().getWriter();
  const startedAt = Date.now();
  try {
    await writer.write({ type: "command_start", id, command, at: startedAt });
    const result = await sandbox.runCommand({ cmd: "bash", args: ["-c", command] });
    const stdout = await result.stdout();
    if (stdout) await writer.write({ type: "command_output", id, stream: "stdout", data: stdout });
    const stderr = await result.stderr();
    if (stderr) await writer.write({ type: "command_output", id, stream: "stderr", data: stderr });
    await writer.write({ type: "command_end", id, exitCode: result.exitCode, durationMs: Date.now() - startedAt });
  } finally {
    writer.releaseLock();
  }
}

export async function sandboxSessionWorkflow() {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  // Create the hook ONCE outside the loop — reused every iteration.
  // Re-creating inside the loop with the same token would throw HookConflictError.
  const hook = commandHook.create({ token: workflowRunId });

  const startedAt = Date.now();
  let sandbox: Sandbox = await Sandbox.create({ runtime: RUNTIME, timeout: SANDBOX_TIMEOUT_MS });
  let sandboxCreatedAt = Date.now();
  let sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;

  await emit({ type: "created", sandboxId: sandbox.name, runtime: RUNTIME, startedAt, sandboxExpiresAt, hibernateAfterMs: HIBERNATE_AFTER_MS });
  await emit({ type: "status", state: "active", at: Date.now(), sandboxId: sandbox.name, sandboxExpiresAt });

  let snapshot: Snapshot | null = null;
  let hibernated = false;
  let lastActivityAt = startedAt;
  let counter = 0;
  let destroyed = false;

  try {
    while (!destroyed) {
      if (hibernated && snapshot) {
        // VM stopped — wait for next command (zero compute cost).
        const payload = await hook;
        if (payload.command === "/destroy") { destroyed = true; break; }

        await emit({ type: "status", state: "resuming", at: Date.now() });
        sandbox = await Sandbox.create({ source: { type: "snapshot", snapshotId: snapshot.snapshotId }, timeout: SANDBOX_TIMEOUT_MS });
        sandboxCreatedAt = Date.now();
        sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;
        hibernated = false;
        snapshot = null;
        await emit({ type: "status", state: "active", at: Date.now(), sandboxId: sandbox.name, sandboxExpiresAt });
        counter += 1;
        await runCommandAndStream(sandbox, \`cmd-\${counter}\`, payload.command);
        lastActivityAt = Date.now();
        await emit({ type: "activity", at: lastActivityAt });
        continue;
      }

      // Active — sleep until idle deadline or refresh deadline, whichever is sooner.
      const idleDeadline = lastActivityAt + HIBERNATE_AFTER_MS;
      const refreshDeadline = sandboxExpiresAt - REFRESH_SAFETY_MS;
      const sleepMs = Math.max(0, Math.min(idleDeadline, refreshDeadline) - Date.now());

      const outcome = await Promise.race([
        hook.then((p) => ({ type: "command" as const, command: p.command })),
        sleep(\`\${sleepMs}ms\`).then(() => ({ type: "timer" as const })),
      ]);

      if (outcome.type === "timer") {
        const nearExpiry = Date.now() >= refreshDeadline;
        if (nearExpiry) {
          // Proactive refresh — snapshot + recreate so session outlives the VM cap.
          await emit({ type: "status", state: "refreshing", at: Date.now() });
          const snap = await sandbox.snapshot();
          sandbox = await Sandbox.create({ source: { type: "snapshot", snapshotId: snap.snapshotId }, timeout: SANDBOX_TIMEOUT_MS });
          sandboxCreatedAt = Date.now();
          sandboxExpiresAt = sandboxCreatedAt + SANDBOX_TIMEOUT_MS;
          await emit({ type: "status", state: "active", at: Date.now(), sandboxId: sandbox.name, sandboxExpiresAt, snapshotId: snap.snapshotId });
          lastActivityAt = Date.now();
        } else {
          // Idle — snapshot and hibernate indefinitely.
          await emit({ type: "status", state: "hibernating", at: Date.now() });
          snapshot = await sandbox.snapshot();
          hibernated = true;
          await emit({ type: "status", state: "hibernated", at: Date.now(), snapshotId: snapshot.snapshotId });
        }
        continue;
      }

      if (outcome.command === "/destroy") { destroyed = true; break; }

      counter += 1;
      await runCommandAndStream(sandbox, \`cmd-\${counter}\`, outcome.command);
      lastActivityAt = Date.now();
      await emit({ type: "activity", at: lastActivityAt });
    }
  } finally {
    if (!hibernated) {
      try { if (sandbox.status === "running") await sandbox.stop(); } catch { /* best-effort */ }
    }
    await emit({ type: "status", state: "destroyed", at: Date.now() });
    await emit({ type: "result", status: "destroyed", durationMs: Date.now() - startedAt });
  }
}
`;

export const sandboxStartRouteSource = `import { start, getRun } from "workflow/api";
import { sandboxSessionWorkflow } from "@/app/workflows/sandbox-session";

export async function POST(req: Request) {
  let body: { runId?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    /* ignore malformed body */
  }

  // Reconnect path: if the client sends a known runId, replay the durable
  // event log from index 0 so the UI fully rehydrates.
  if (body.runId) {
    const run = getRun(body.runId);
    if (await run.exists) {
      const readable = run.getReadable({ startIndex: 0 });
      return new Response(readable.pipeThrough(ndjson()), {
        headers: {
          "Content-Type": "application/x-ndjson",
          "x-workflow-run-id": body.runId,
          "x-workflow-reconnected": "true",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }
    // Stale runId — fall through to start fresh.
  }

  const run = await start(sandboxSessionWorkflow, []);
  return new Response(run.readable.pipeThrough(ndjson()), {
    headers: {
      "Content-Type": "application/x-ndjson",
      "x-workflow-run-id": run.runId,
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

function ndjson<T>() {
  return new TransformStream<T, string>({
    transform(chunk, controller) {
      controller.enqueue(JSON.stringify(chunk) + "\\n");
    },
  });
}
`;

export const sandboxCommandRouteSource = `import { commandHook } from "@/app/workflows/sandbox-session";

export async function POST(req: Request) {
  const { runId, command } = (await req.json()) as {
    runId?: string;
    command?: string;
  };

  if (!runId || typeof command !== "string") {
    return Response.json(
      { error: "runId and command are required" },
      { status: 400 }
    );
  }

  try {
    await commandHook.resume(runId, { command });
    return Response.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (msg.includes("not found") || msg.includes("expired")) {
      return Response.json(
        { ok: false, note: "session expired" },
        { status: 410 }
      );
    }
    throw error;
  }
}
`;

export const sandboxClientSource = `"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxEvent } from "@/app/workflows/sandbox-session";

const RUN_ID_KEY = "sandbox.runId";

export function SandboxRunner() {
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  const runIdRef = useRef<string | null>(null);
  const didReconnectRef = useRef(false);

  const consume = useCallback(async (res: Response) => {
    if (!res.ok || !res.body) return;
    runIdRef.current = res.headers.get("x-workflow-run-id");
    if (runIdRef.current) {
      localStorage.setItem(RUN_ID_KEY, runIdRef.current);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          setEvents((prev) => [...prev, JSON.parse(line) as SandboxEvent]);
        } catch { /* malformed line */ }
      }
    }
  }, []);

  const openStream = useCallback(
    async (runId?: string) => {
      setEvents([]);
      const res = await fetch("/api/sandbox/start", {
        method: "POST",
        headers: runId ? { "Content-Type": "application/json" } : undefined,
        body: runId ? JSON.stringify({ runId }) : undefined,
      });
      await consume(res);
    },
    [consume]
  );

  // Auto-reconnect on mount if a runId is stashed in localStorage.
  useEffect(() => {
    if (didReconnectRef.current) return;
    didReconnectRef.current = true;
    const stored = localStorage.getItem(RUN_ID_KEY);
    if (stored) openStream(stored);
  }, [openStream]);

  const start = useCallback(() => {
    localStorage.removeItem(RUN_ID_KEY);
    runIdRef.current = null;
    openStream();
  }, [openStream]);

  const sendCommand = useCallback(async (command: string) => {
    if (!runIdRef.current) return;
    const res = await fetch("/api/sandbox/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: runIdRef.current, command }),
    });
    if (res.status === 410) localStorage.removeItem(RUN_ID_KEY);
  }, []);

  const destroy = useCallback(async () => {
    await sendCommand("/destroy");
    localStorage.removeItem(RUN_ID_KEY);
  }, [sendCommand]);

  // Render events as a terminal-style log. Drive UI state from \`status\` events
  // (active / hibernating / hibernated / resuming / refreshing / destroyed).
  return null;
}
`;

export const sandboxPipelineInstallSource = `/**
 * Vercel Sandbox — one-shot pipeline (quickstart).
 *
 * THE PATTERN:
 *   Each \`Sandbox\` method (\`create\`, \`runCommand\`, \`stop\`) is an implicit
 *   workflow step. The runtime persists the result of every call so on a
 *   restart the workflow skips already-completed steps and resumes from the
 *   last successful one — no duplicate sandbox charges, no lost output.
 *
 * USEFUL WHEN:
 *   - You need to run a short, finite list of shell commands in a clean VM.
 *   - You want crash-safety for free without managing the full session loop.
 *   - You are prototyping before graduating to the full sandbox-session pattern.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the \`commands\` array with whatever shell commands your use
 *     case needs (install deps, run tests, compile, etc.).
 *   - Change the runtime to \`python3.13\`, \`deno2\`, etc. as needed.
 *   - For long-running interactive sessions with a persistent sandbox,
 *     see the full sandbox-session pattern instead.
 *
 * DOCS: https://workflow-sdk.dev/patterns/sandbox
 */
import { Sandbox } from "@vercel/sandbox";

export async function sandboxPipeline(input: { commands: string[] }) {
  "use workflow";

  const sandbox = await Sandbox.create({ runtime: "node22" });

  try {
    const results = [];
    for (const command of input.commands) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
      });
      results.push({
        command,
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      });
    }
    return { status: "completed", results };
  } finally {
    await sandbox.stop();
  }
}
`;

export const sandboxUsageSource = `// Quickstart — one-shot pipeline.
// Each \`Sandbox\` method (\`create\`, \`runCommand\`, \`stop\`, \`snapshot\`) is an
// implicit step, so the event log records every command and the workflow
// replays from the last completed call on restart.
import { Sandbox } from "@vercel/sandbox";

export async function sandboxPipeline(input: { commands: string[] }) {
  "use workflow";

  const sandbox = await Sandbox.create({ runtime: "node22" });

  try {
    const results = [];
    for (const command of input.commands) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
      });
      results.push({
        command,
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      });
    }
    return { status: "completed", results };
  } finally {
    await sandbox.stop();
  }
}
`;
