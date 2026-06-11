/**
 * Source snippets for the Child Workflows registry entry.
 *
 * Spawn-and-wait-via-hook pattern for orchestrating many independent
 * workflow runs from a parent — each child has its own runId, event log,
 * and retry boundary, so a failing child never takes down siblings or the
 * parent. Instead of polling `getRun().status` in a sleep loop, each child
 * resumes a completion hook on the parent when it finishes: zero compute
 * while waiting, immediate wake-up, and a typed result payload.
 * Ships parent + child + completion hook + spawn step + startAndWait helper.
 */

export const childWorkflowsWorkflowSource = `import { defineHook, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";

// Completion hook — the child resumes this on the parent when it finishes.
// The discriminated union carries either the child's return value or its
// error message, so the parent never has to poll or fetch returnValue.
const childCompletionHook = defineHook({
  schema: z.discriminatedUnion("status", [
    z.object({ status: z.literal("completed"), value: z.unknown() }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

// Stable token per (parent run, child key) so parallel children inside one
// parent run never collide on hook tokens.
function completionToken(parentRunId: string, key: string) {
  return \`child-completion:\${parentRunId}:\${key}\`;
}

// resume() must be called from a step.
async function resumeParentCompletion(
  token: string,
  result:
    | { status: "completed"; value: unknown }
    | { status: "failed"; error: string },
) {
  "use step";
  await childCompletionHook.resume(token, result);
}

// Runs the real child in try/catch/finally and reports the outcome to the
// parent's hook — including failures, so the parent always wakes up.
async function withChildCompletionHook<TResult>(
  runChild: () => Promise<TResult>,
  completionTokenArg: string,
) {
  let result:
    | { status: "completed"; value: TResult }
    | { status: "failed"; error: string }
    | undefined;

  try {
    const value = await runChild();
    result = { status: "completed", value };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (result) {
      await resumeParentCompletion(completionTokenArg, result);
    }
  }
}

// CHILD — one independent unit of work. Replace the steps with real logic.
export async function processDocument(documentId: string) {
  "use workflow";

  const content = await fetchDocument(documentId);
  const analysis = await analyzeContent(content);
  const summary = await generateSummary(analysis);

  return { documentId, summary };
}

// Spawnable wrapper — explicit module-scope export so start() can register
// it. A runtime higher-order function cannot be passed to start().
export async function processDocumentWithCompletion(
  documentId: string,
  completionTokenArg: string,
) {
  "use workflow";

  await withChildCompletionHook(
    () => processDocument(documentId),
    completionTokenArg,
  );
}

// start() must be called from a step in v4. (In v5 it can also be called
// directly from a workflow function.) deploymentId: "latest" makes children
// pick up future deployments.
async function spawnProcessDocument(
  documentId: string,
  completionTokenArg: string,
): Promise<void> {
  "use step";
  await start(processDocumentWithCompletion, [documentId, completionTokenArg], {
    deploymentId: "latest",
  });
}

// Create the hook, spawn the child with the token, suspend until the child
// resumes it, then unwrap the typed result.
async function startAndWait<TResult>(
  key: string,
  startChild: (completionTokenArg: string) => Promise<void>,
): Promise<TResult> {
  const { workflowRunId } = getWorkflowMetadata();
  const token = completionToken(workflowRunId, key);
  const hook = childCompletionHook.create({ token });

  await startChild(token);

  const completion = await hook;
  if (completion.status === "failed") {
    throw new Error(completion.error);
  }
  return completion.value as TResult;
}

// PARENT — orchestrates many children and waits for all of them.
// Swap Promise.all for Promise.allSettled to tolerate partial failures.
export async function processDocumentBatch(documentIds: string[]) {
  "use workflow";

  const results = await Promise.all(
    documentIds.map((documentId) =>
      startAndWait<{ documentId: string; summary: string }>(
        documentId,
        (token) => spawnProcessDocument(documentId, token),
      ),
    ),
  );

  return { processed: results.length, results };
}

// Replace the step bodies below with your real per-document work.
async function fetchDocument(documentId: string): Promise<string> {
  "use step";
  const res = await fetch(\`https://docs.example.com/api/\${documentId}\`);
  return res.text();
}

async function analyzeContent(content: string): Promise<string> {
  "use step";
  return \`analysis of \${content.length} chars\`;
}

async function generateSummary(analysis: string): Promise<string> {
  "use step";
  return \`Summary: \${analysis}\`;
}
`;

export const childWorkflowsWorkflowInstallSource = `/**
 * Child Workflows — spawn independent runs and wait via hook resume.
 *
 * THE PATTERN:
 *   1. The parent creates a completion hook per child (stable token derived
 *      from the parent runId + a child key) and suspends on it — zero
 *      compute while waiting, immediate wake-up when the child finishes.
 *   2. Each child is an independent workflow run with its own runId, event
 *      log, and retry boundary — a failing child never affects siblings.
 *   3. A wrapped child export runs the real child in try/catch/finally and
 *      resumes the parent's hook with { status, value | error } from a step,
 *      so the parent always wakes up, even on failure.
 *   4. startAndWait() ties hook creation, spawning, and the typed result
 *      together; Promise.all fans out over many children.
 *
 * WHY HOOKS INSTEAD OF POLLING getRun().status:
 *   - Zero compute while waiting — no sleep() poll loop waking the parent.
 *   - Immediate wake-up when the child finishes, not on the next poll tick.
 *   - Typed payloads — the child sends { status, value | error } directly;
 *     no separate returnValue fetch step.
 *   - No worker-pool pressure from polling inside steps.
 *
 * USEFUL WHEN:
 *   - Processing many independent items (documents, users, records) in
 *     parallel with isolated failure handling per item.
 *   - You need per-item run IDs for individual observability and cancellation.
 *   - Children have long runtimes and you want the parent to survive restarts
 *     while waiting for them.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace processDocument with your child workflow function.
 *   - Replace the fetchDocument / analyzeContent / generateSummary steps
 *     with your real per-item work.
 *   - Use Promise.allSettled instead of Promise.all to tolerate partial
 *     failures — the hook payload already carries { status: "failed", error }.
 *   - For hundreds of children, chunk the spawn calls (10-50 at a time) to
 *     avoid a large burst of work.
 *   - To retry a failed child, call startAndWait again with a fresh key
 *     (e.g. documentId + ":" + attempt) so the new hook token doesn't
 *     collide with the old one.
 *   - { deploymentId: "latest" } on start() lets children pick up future
 *     code deployments automatically during long-running parent runs.
 *
 * DOCS: https://workflow-sdk.dev/patterns/child-workflows
 */
import { defineHook, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";

// Completion hook — the child resumes this on the parent when it finishes.
// The discriminated union carries either the child's return value or its
// error message, so the parent never has to poll or fetch returnValue.
const childCompletionHook = defineHook({
  schema: z.discriminatedUnion("status", [
    z.object({ status: z.literal("completed"), value: z.unknown() }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

// Stable token per (parent run, child key) so parallel children inside one
// parent run never collide on hook tokens.
function completionToken(parentRunId: string, key: string) {
  return \`child-completion:\${parentRunId}:\${key}\`;
}

// resume() must be called from a step.
async function resumeParentCompletion(
  token: string,
  result:
    | { status: "completed"; value: unknown }
    | { status: "failed"; error: string },
) {
  "use step";
  await childCompletionHook.resume(token, result);
}

// Runs the real child in try/catch/finally and reports the outcome to the
// parent's hook — including failures, so the parent always wakes up.
async function withChildCompletionHook<TResult>(
  runChild: () => Promise<TResult>,
  completionTokenArg: string,
) {
  let result:
    | { status: "completed"; value: TResult }
    | { status: "failed"; error: string }
    | undefined;

  try {
    const value = await runChild();
    result = { status: "completed", value };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (result) {
      await resumeParentCompletion(completionTokenArg, result);
    }
  }
}

// CHILD — one independent unit of work. Replace the steps with real logic.
export async function processDocument(documentId: string) {
  "use workflow";

  const content = await fetchDocument(documentId);
  const analysis = await analyzeContent(content);
  const summary = await generateSummary(analysis);

  return { documentId, summary };
}

// Spawnable wrapper — explicit module-scope export so start() can register
// it. A runtime higher-order function cannot be passed to start().
export async function processDocumentWithCompletion(
  documentId: string,
  completionTokenArg: string,
) {
  "use workflow";

  await withChildCompletionHook(
    () => processDocument(documentId),
    completionTokenArg,
  );
}

// start() must be called from a step in v4. (In v5 it can also be called
// directly from a workflow function.) deploymentId: "latest" makes children
// pick up future deployments.
async function spawnProcessDocument(
  documentId: string,
  completionTokenArg: string,
): Promise<void> {
  "use step";
  await start(processDocumentWithCompletion, [documentId, completionTokenArg], {
    deploymentId: "latest",
  });
}

// Create the hook, spawn the child with the token, suspend until the child
// resumes it, then unwrap the typed result.
async function startAndWait<TResult>(
  key: string,
  startChild: (completionTokenArg: string) => Promise<void>,
): Promise<TResult> {
  const { workflowRunId } = getWorkflowMetadata();
  const token = completionToken(workflowRunId, key);
  const hook = childCompletionHook.create({ token });

  await startChild(token);

  const completion = await hook;
  if (completion.status === "failed") {
    throw new Error(completion.error);
  }
  return completion.value as TResult;
}

// PARENT — orchestrates many children and waits for all of them.
// Swap Promise.all for Promise.allSettled to tolerate partial failures.
export async function processDocumentBatch(documentIds: string[]) {
  "use workflow";

  const results = await Promise.all(
    documentIds.map((documentId) =>
      startAndWait<{ documentId: string; summary: string }>(
        documentId,
        (token) => spawnProcessDocument(documentId, token),
      ),
    ),
  );

  return { processed: results.length, results };
}

// Replace the step bodies below with your real per-document work.
async function fetchDocument(documentId: string): Promise<string> {
  "use step";
  const res = await fetch(\`https://docs.example.com/api/\${documentId}\`);
  return res.text();
}

async function analyzeContent(content: string): Promise<string> {
  "use step";
  return \`analysis of \${content.length} chars\`;
}

async function generateSummary(analysis: string): Promise<string> {
  "use step";
  return \`Summary: \${analysis}\`;
}
`;

export const childWorkflowsStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { processDocumentBatch } from "@/app/workflows/child-workflows";

// POST /api/child-workflows { documentIds: string[] }
export async function POST(request: Request) {
  const { documentIds } = (await request.json()) as { documentIds: string[] };

  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return NextResponse.json(
      { error: "documentIds must be a non-empty array" },
      { status: 400 },
    );
  }

  const run = await start(processDocumentBatch, [documentIds]);
  return NextResponse.json({ runId: run.runId });
}
`;
