/**
 * Source snippets for the Workflow Composition registry entry.
 *
 * Two ways to compose workflows: direct `await` flattens the child into the
 * parent's event log; `start()` from inside a step spawns the child as an
 * independent run with its own runId.
 */

export const workflowCompositionWorkflowSource = `import { start } from "workflow/api";

// CHILD WORKFLOW — runs as part of the parent's event log when awaited.
export async function sendNotifications(userId: string) {
  "use workflow";

  await sendEmail(userId);
  await sendPushNotification(userId);
  return { notified: true };
}

// PARENT — direct await: flattens the child inline.
export async function onboardUser(userId: string) {
  "use workflow";

  await createAccount(userId);
  await sendNotifications(userId);
  await setupPreferences(userId);

  return { userId, status: "onboarded" };
}

// PARENT — background spawn: child runs independently with its own runId.
// Note: start() must be called from a step, not directly from a workflow.
export async function processOrder(orderId: string) {
  "use workflow";

  const order = await fulfillOrder(orderId);
  const reportRunId = await triggerReport(orderId);
  await sendConfirmation(orderId);

  return { orderId, order, reportRunId };
}

async function triggerReport(orderId: string): Promise<string> {
  "use step";
  // Spawn the child workflow on the latest deployment so future
  // upgrades pick it up automatically.
  const run = await start(generateReport, [orderId], { deploymentId: "latest" });
  return run.runId;
}

// Background-spawnable child — runs independently when started.
export async function generateReport(reportId: string) {
  "use workflow";
  await buildReport(reportId);
  return { reportId, status: "ready" };
}

async function sendEmail(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/email/\${userId}\`, { method: "POST" });
}

async function sendPushNotification(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/push/\${userId}\`, { method: "POST" });
}

async function createAccount(userId: string): Promise<void> {
  "use step";
  await fetch("https://api.example.com/accounts", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

async function setupPreferences(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/preferences/\${userId}\`, { method: "PUT" });
}

async function fulfillOrder(orderId: string): Promise<{ id: string }> {
  "use step";
  return { id: orderId };
}

async function sendConfirmation(orderId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/orders/\${orderId}/confirm\`, { method: "POST" });
}

async function buildReport(reportId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/reports/\${reportId}\`, { method: "POST" });
}
`;

export const workflowCompositionWorkflowInstallSource = `/**
 * Workflow Composition — compose workflows via direct await or background spawn.
 *
 * THE PATTERN:
 *   DIRECT AWAIT: calling another workflow function with await flattens it
 *   into the parent's event log — one run, shared lifecycle.
 *
 *   BACKGROUND SPAWN: calling start() from a step spawns the child as an
 *   independent run — its own runId, event log, retry boundary, and status.
 *   The parent only gets a runId back; it doesn't wait for the child.
 *
 * USEFUL WHEN:
 *   DIRECT AWAIT:
 *     - Sub-flows you want to reuse across multiple parent workflows.
 *     - The parent needs the child's output before continuing.
 *     - You want a single observable run in your dashboard.
 *
 *   BACKGROUND SPAWN:
 *     - Fire-and-forget side effects (generate report, send analytics).
 *     - The child takes much longer than the parent needs.
 *     - You want the child cancellable / observable independently.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace sendNotifications / onboardUser with your domain workflows.
 *   - Replace generateReport / processOrder with your background tasks.
 *   - { deploymentId: "latest" } on start() lets the child pick up future
 *     code deployments automatically — omit for pinned behavior.
 *   - If the parent needs to await the child's result, see Child Workflows
 *     (hook-based completion instead of polling).
 *
 * DOCS: https://workflow-sdk.dev/patterns/workflow-composition
 */
import { start } from "workflow/api";

// CHILD WORKFLOW — runs as part of the parent's event log when awaited directly.
export async function sendNotifications(userId: string) {
  "use workflow";

  await sendEmail(userId);
  await sendPushNotification(userId);
  return { notified: true };
}

// PARENT — direct await: flattens sendNotifications inline.
export async function onboardUser(userId: string) {
  "use workflow";

  await createAccount(userId);
  // Direct await: child steps appear in this run's event log.
  await sendNotifications(userId);
  await setupPreferences(userId);

  return { userId, status: "onboarded" };
}

// PARENT — background spawn: child runs independently with its own runId.
// Note: start() must be called from a step, not directly from a workflow.
export async function processOrder(orderId: string) {
  "use workflow";

  const order = await fulfillOrder(orderId);
  // triggerReport is a step that calls start() — spawns an independent child.
  const reportRunId = await triggerReport(orderId);
  await sendConfirmation(orderId);

  return { orderId, order, reportRunId };
}

async function triggerReport(orderId: string): Promise<string> {
  "use step";
  // deploymentId: "latest" → child picks up future code deployments.
  const run = await start(generateReport, [orderId], { deploymentId: "latest" });
  return run.runId;
}

// Background-spawnable child — independent run when started via start().
export async function generateReport(reportId: string) {
  "use workflow";
  await buildReport(reportId);
  return { reportId, status: "ready" };
}

async function sendEmail(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/email/\${userId}\`, { method: "POST" });
}

async function sendPushNotification(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/push/\${userId}\`, { method: "POST" });
}

async function createAccount(userId: string): Promise<void> {
  "use step";
  await fetch("https://api.example.com/accounts", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

async function setupPreferences(userId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/preferences/\${userId}\`, { method: "PUT" });
}

async function fulfillOrder(orderId: string): Promise<{ id: string }> {
  "use step";
  return { id: orderId };
}

async function sendConfirmation(orderId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/orders/\${orderId}/confirm\`, { method: "POST" });
}

async function buildReport(reportId: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/reports/\${reportId}\`, { method: "POST" });
}
`;

export const workflowCompositionStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { onboardUser } from "@/app/workflows/workflow-composition";

// POST /api/workflow-composition { userId }
export async function POST(request: Request) {
  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const run = await start(onboardUser, [userId]);
  return NextResponse.json({ runId: run.runId });
}
`;
