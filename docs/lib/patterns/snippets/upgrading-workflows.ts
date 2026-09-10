/**
 * Source snippets for the Upgrading Workflows registry entry.
 *
 * Self-upgrading pattern — long-running runs that respawn themselves on the
 * latest deployment so shipped fixes take effect on the very next event,
 * without migrating in-flight state. Ships Method 1 (per-iteration spawn)
 * out of the box; the start and resume routes work for both methods.
 */

export const upgradingWorkflowsWorkflowSource = `import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";

// ---------------------------------------------------------------------------
// Deployment identifier — captured once at process start.
// On Vercel, VERCEL_DEPLOYMENT_ID changes on every deploy so each version
// reports a distinct ID. Locally a timestamp simulates a redeploy on restart.
// ---------------------------------------------------------------------------
const DEPLOYMENT_ID =
  process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 12) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  \`dev-\${Date.now().toString(36)}\`;

// ---------------------------------------------------------------------------
// State — replace with your domain's shape (queue cursor, FSM, subscription…)
// ---------------------------------------------------------------------------
export interface WorkflowState {
  count: number;
  history: IterationRecord[];
}

export interface IterationRecord {
  runId: string;
  deploymentId: string;
  incrementedBy: number;
  result: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Hook — token = runId so each chain is isolated. Export so the resume
// route can call hook.resume(runId, payload) without a shared singleton.
// ---------------------------------------------------------------------------
export const resumeHook = defineHook<{ amount: number }>();

// ---------------------------------------------------------------------------
// Workflow — ONE iteration per run (Method 1).
//
//   1. Emit current state to the stream so clients can read it.
//   2. Block on the hook until an external trigger resumes it.
//   3. Compute next state, emit progress.
//   4. Spawn the next iteration with deploymentId "latest" so it picks up
//      whichever deployment is live at that moment.
//   5. Exit — the chain continues on a fresh run.
// ---------------------------------------------------------------------------
export async function upgradingWorkflow(
  state: WorkflowState = { count: 0, history: [] },
): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  // Emit ready so listeners know which run / deployment is active.
  await emitEvent({ type: "ready", runId: workflowRunId, deploymentId: DEPLOYMENT_ID, state });

  // Suspend until the caller resumes this specific run.
  const payload = await resumeHook.create({ token: workflowRunId });

  // Process on this deployment's code path.
  const result = state.count + payload.amount;
  const newState: WorkflowState = {
    count: result,
    history: [
      ...state.history,
      { runId: workflowRunId, deploymentId: DEPLOYMENT_ID, incrementedBy: payload.amount, result, at: new Date().toISOString() },
    ],
  };

  await emitEvent({ type: "incremented", payload, newState });

  // Spawn the successor on the latest deployment, then exit.
  const nextRunId = await spawnSelfOnLatest(newState);
  await emitEvent({ type: "spawned", nextRunId });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// start() must run inside a "use step" function.
// deploymentId: "latest" is the key to the upgrade pattern — the new run
// picks up whichever deployment is live when it lands, not the caller's.
async function spawnSelfOnLatest(state: WorkflowState): Promise<string> {
  "use step";
  const next = await start(upgradingWorkflow, [state], { deploymentId: "latest" });
  return next.runId;
}

type UpgradeEvent =
  | { type: "ready"; runId: string; deploymentId: string; state: WorkflowState }
  | { type: "incremented"; payload: { amount: number }; newState: WorkflowState }
  | { type: "spawned"; nextRunId: string };

async function emitEvent(event: UpgradeEvent): Promise<void> {
  "use step";
  const writer = getWritable<UpgradeEvent>().getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}
`;

// Method 2 — long-running loop + dedicated upgrade hook.
// The workflow handles many events per run; a separate upgradeHook forces
// an explicit respawn on the latest deployment whenever you choose.
export const upgradingWorkflowsMethod2Source = `import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";

const DEPLOYMENT_ID =
  process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 12) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  \`dev-\${Date.now().toString(36)}\`;

export interface WorkflowState {
  count: number;
  history: IterationRecord[];
}

export interface IterationRecord {
  runId: string;
  deploymentId: string;
  incrementedBy: number;
  result: number;
  at: string;
}

// Work hook — resumes with a payload to process
export const resumeHook = defineHook<{ amount: number }>();
// Upgrade hook — fire this to force a respawn on the latest deployment
export const upgradeHook = defineHook<void>();

export async function upgradingWorkflow(
  state: WorkflowState = { count: 0, history: [] },
): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  await emitEvent({ type: "ready", runId: workflowRunId, deploymentId: DEPLOYMENT_ID, state });

  while (true) {
    // Race: process the next event OR upgrade to the latest deployment
    const outcome = await Promise.race([
      resumeHook
        .create({ token: \`work:\${workflowRunId}\` })
        .then((p) => ({ kind: "work" as const, payload: p })),
      upgradeHook
        .create({ token: \`upgrade:\${workflowRunId}\` })
        .then(() => ({ kind: "upgrade" as const })),
    ]);

    if (outcome.kind === "upgrade") {
      // Spawn successor on the latest deployment and exit
      const nextRunId = await spawnSelfOnLatest(state);
      await emitEvent({ type: "spawned", nextRunId });
      return;
    }

    // Process the event on this deployment's code path
    const result = state.count + outcome.payload.amount;
    state = {
      count: result,
      history: [
        ...state.history,
        {
          runId: workflowRunId,
          deploymentId: DEPLOYMENT_ID,
          incrementedBy: outcome.payload.amount,
          result,
          at: new Date().toISOString(),
        },
      ],
    };

    await emitEvent({ type: "incremented", payload: outcome.payload, newState: state });
  }
}

async function spawnSelfOnLatest(state: WorkflowState): Promise<string> {
  "use step";
  const next = await start(upgradingWorkflow, [state], { deploymentId: "latest" });
  return next.runId;
}

type UpgradeEvent =
  | { type: "ready"; runId: string; deploymentId: string; state: WorkflowState }
  | { type: "incremented"; payload: { amount: number }; newState: WorkflowState }
  | { type: "spawned"; nextRunId: string };

async function emitEvent(event: UpgradeEvent): Promise<void> {
  "use step";
  const writer = getWritable<UpgradeEvent>().getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}
`;

// ─── Method 1 install code ────────────────────────────────────────────────────
export const upgradingWorkflowsMethod1InstallSource = `/**
 * Upgrading Workflows — Method 1: per-event spawn (simple, always up-to-date).
 *
 * THE PATTERN:
 *   1. One run = one iteration. The workflow handles one event then exits.
 *   2. Before exiting, it spawns a successor run with deploymentId: "latest"
 *      so the next iteration runs on whichever deployment is live then.
 *   3. State is passed explicitly as arguments — no shared DB, no migration.
 *
 * USEFUL WHEN:
 *   - Every event should benefit immediately from the latest code.
 *   - You prefer simplicity over fine-grained upgrade control.
 *   - Your state shape is small enough to pass as function arguments.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace WorkflowState / IterationRecord with your domain's state shape.
 *   - Replace the increment logic with your event processing (queue consumer,
 *     FSM transition, subscription renewal, etc.).
 *   - Customize the emitEvent helper or remove it if you don't need streaming.
 *   - The resumeHook token = runId so each iteration is independently resumable
 *     without a shared registry.
 *
 * DOCS: https://workflow-sdk.dev/patterns/upgrading-workflows
 */
import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";

// Captured once per process — changes on every deploy on Vercel.
const DEPLOYMENT_ID =
  process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 12) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  \`dev-\${Date.now().toString(36)}\`;

export interface WorkflowState {
  count: number;
  history: IterationRecord[];
}

export interface IterationRecord {
  runId: string;
  deploymentId: string;
  incrementedBy: number;
  result: number;
  at: string;
}

// Token = runId so each iteration is isolated and independently resumable.
export const resumeHook = defineHook<{ amount: number }>();

export async function upgradingWorkflow(
  state: WorkflowState = { count: 0, history: [] },
): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  // 1. Emit ready so clients know which run/deployment is active.
  await emitEvent({ type: "ready", runId: workflowRunId, deploymentId: DEPLOYMENT_ID, state });

  // 2. Suspend until an external trigger resumes this specific run.
  const payload = await resumeHook.create({ token: workflowRunId });

  // 3. Process on this deployment's code — swap logic here for domain work.
  const result = state.count + payload.amount;
  const newState: WorkflowState = {
    count: result,
    history: [
      ...state.history,
      { runId: workflowRunId, deploymentId: DEPLOYMENT_ID, incrementedBy: payload.amount, result, at: new Date().toISOString() },
    ],
  };

  await emitEvent({ type: "incremented", payload, newState });

  // 4. Spawn successor on latest deployment — the upgrade happens here.
  const nextRunId = await spawnSelfOnLatest(newState);
  await emitEvent({ type: "spawned", nextRunId });
}

// start() must be inside a "use step" function.
// deploymentId: "latest" is the key — the successor picks up whichever
// deployment is live when it starts, not the caller's deployment.
async function spawnSelfOnLatest(state: WorkflowState): Promise<string> {
  "use step";
  const next = await start(upgradingWorkflow, [state], { deploymentId: "latest" });
  return next.runId;
}

type UpgradeEvent =
  | { type: "ready"; runId: string; deploymentId: string; state: WorkflowState }
  | { type: "incremented"; payload: { amount: number }; newState: WorkflowState }
  | { type: "spawned"; nextRunId: string };

async function emitEvent(event: UpgradeEvent): Promise<void> {
  "use step";
  const writer = getWritable<UpgradeEvent>().getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}
`;

// ─── Method 2 install code ────────────────────────────────────────────────────
export const upgradingWorkflowsMethod2InstallSource = `/**
 * Upgrading Workflows — Method 2: long-running loop + explicit upgrade hook.
 *
 * THE PATTERN:
 *   1. One run handles many events in a loop — runs stay alive longer.
 *   2. An upgradeHook races against the normal work hook. Fire the upgrade
 *      hook when you want to respawn on the latest deployment.
 *   3. On upgrade, the workflow spawns a successor with deploymentId: "latest"
 *      and exits — code updates take effect at the moment you choose.
 *
 * USEFUL WHEN:
 *   - You want the run to stay alive and handle many events before upgrading.
 *   - You need explicit control over when upgrades happen (e.g. off-hours).
 *   - Your state is expensive to serialize between every event.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the increment logic in the work branch with your event handler.
 *   - Replace WorkflowState / IterationRecord with your domain's shape.
 *   - Fire upgradeHook.resume(runId) from a deploy hook or admin API to
 *     trigger a controlled upgrade at the time of your choosing.
 *   - Both hooks use separate token prefixes ("work:" vs "upgrade:") so a
 *     single runId can carry both concurrently without conflict.
 *
 * DOCS: https://workflow-sdk.dev/patterns/upgrading-workflows
 */
import { defineHook, getWritable, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";

const DEPLOYMENT_ID =
  process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 12) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  \`dev-\${Date.now().toString(36)}\`;

export interface WorkflowState {
  count: number;
  history: IterationRecord[];
}

export interface IterationRecord {
  runId: string;
  deploymentId: string;
  incrementedBy: number;
  result: number;
  at: string;
}

// Work hook — resumes with a payload to process.
export const resumeHook = defineHook<{ amount: number }>();
// Upgrade hook — fire this to force a respawn on the latest deployment.
export const upgradeHook = defineHook<void>();

export async function upgradingWorkflow(
  state: WorkflowState = { count: 0, history: [] },
): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  await emitEvent({ type: "ready", runId: workflowRunId, deploymentId: DEPLOYMENT_ID, state });

  while (true) {
    // Race: process next event OR upgrade to the latest deployment.
    // Separate token prefixes prevent HookConflictError.
    const outcome = await Promise.race([
      resumeHook
        .create({ token: \`work:\${workflowRunId}\` })
        .then((p) => ({ kind: "work" as const, payload: p })),
      upgradeHook
        .create({ token: \`upgrade:\${workflowRunId}\` })
        .then(() => ({ kind: "upgrade" as const })),
    ]);

    if (outcome.kind === "upgrade") {
      // Controlled upgrade: spawn successor on the latest deployment and exit.
      const nextRunId = await spawnSelfOnLatest(state);
      await emitEvent({ type: "spawned", nextRunId });
      return;
    }

    // Process the event on this deployment's code.
    const result = state.count + outcome.payload.amount;
    state = {
      count: result,
      history: [
        ...state.history,
        {
          runId: workflowRunId,
          deploymentId: DEPLOYMENT_ID,
          incrementedBy: outcome.payload.amount,
          result,
          at: new Date().toISOString(),
        },
      ],
    };

    await emitEvent({ type: "incremented", payload: outcome.payload, newState: state });
  }
}

async function spawnSelfOnLatest(state: WorkflowState): Promise<string> {
  "use step";
  const next = await start(upgradingWorkflow, [state], { deploymentId: "latest" });
  return next.runId;
}

type UpgradeEvent =
  | { type: "ready"; runId: string; deploymentId: string; state: WorkflowState }
  | { type: "incremented"; payload: { amount: number }; newState: WorkflowState }
  | { type: "spawned"; nextRunId: string };

async function emitEvent(event: UpgradeEvent): Promise<void> {
  "use step";
  const writer = getWritable<UpgradeEvent>().getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}
`;

export const upgradingWorkflowsStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { upgradingWorkflow, type WorkflowState } from "@/app/workflows/upgrading-workflows;

// POST /api/upgrade — starts the first iteration of the chain.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    initial?: WorkflowState;
  };
  const initial: WorkflowState = body.initial ?? { count: 0, history: [] };
  const run = await start(upgradingWorkflow, [initial]);
  return NextResponse.json({ runId: run.runId });
}
`;

export const upgradingWorkflowsResumeRouteSource = `import { NextResponse } from "next/server";
import { resumeHook } from "@/app/workflows/upgrading-workflows;

// POST /api/upgrade/resume { runId, amount }
// Resumes the active iteration, triggering a state update and a spawn.
export async function POST(request: Request) {
  const { runId, amount } = (await request.json()) as {
    runId?: string;
    amount?: number;
  };

  if (typeof runId !== "string" || typeof amount !== "number") {
    return NextResponse.json(
      { error: "runId (string) and amount (number) are required" },
      { status: 400 },
    );
  }

  try {
    await resumeHook.resume(runId, { amount });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (msg.includes("not found") || msg.includes("expired")) {
      // The run already spawned its successor — caller should use the new runId.
      return NextResponse.json(
        { success: false, note: "Run has already moved to its successor" },
        { status: 409 },
      );
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}
`;
