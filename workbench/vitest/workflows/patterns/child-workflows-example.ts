/**
 * Child Workflows example — document batch processing with startAndWait().
 *
 * The generic machinery lives in ./child-workflows (installed alongside
 * this file). This example shows the wiring:
 *   - a child workflow (processDocument)
 *   - a spawnable wrapper export that reports completion to the parent
 *   - a spawn step (start() must run in a step on v4; v5 also allows
 *     calling it directly from the workflow)
 *   - a parent that fans out with Promise.all + startAndWait()
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
 *   - On Vercel deployments, add { deploymentId: "latest" } to start() so
 *     children pick up future code deployments automatically during
 *     long-running parent runs. (Local dev can't resolve "latest".)
 *
 * DOCS: https://workflow-sdk.dev/patterns/child-workflows
 */
import { start } from 'workflow/api';
import { startAndWait, withChildCompletionHook } from './child-workflows';

// CHILD — one independent unit of work. Replace the steps with real logic.
export async function processDocument(documentId: string) {
  'use workflow';

  const content = await fetchDocument(documentId);
  const analysis = await analyzeContent(content);
  const summary = await generateSummary(analysis);

  return { documentId, summary };
}

// Spawnable wrapper — explicit module-scope export so start() can register
// it. A runtime higher-order function cannot be passed to start().
export async function processDocumentWithCompletion(
  documentId: string,
  completionTokenArg: string
) {
  'use workflow';

  await withChildCompletionHook(
    () => processDocument(documentId),
    completionTokenArg
  );
}

// start() must be called from a step in v4. (In v5 it can also be called
// directly from a workflow function.) On Vercel, pass { deploymentId:
// "latest" } as a third argument so children run on the newest deployment.
async function spawnProcessDocument(
  documentId: string,
  completionTokenArg: string
): Promise<void> {
  'use step';
  await start(processDocumentWithCompletion, [documentId, completionTokenArg]);
}

// PARENT — orchestrates many children and waits for all of them.
// Swap Promise.all for Promise.allSettled to tolerate partial failures.
export async function processDocumentBatch(documentIds: string[]) {
  'use workflow';

  const results = await Promise.all(
    documentIds.map((documentId) =>
      startAndWait<{ documentId: string; summary: string }>(
        documentId,
        (token) => spawnProcessDocument(documentId, token)
      )
    )
  );

  return { processed: results.length, results };
}

// Replace the step bodies below with your real per-document work, e.g.:
//
//   const res = await fetch(`https://docs.your-domain.com/api/${documentId}`);
//   return res.text();
async function fetchDocument(documentId: string): Promise<string> {
  'use step';
  return `Demo content for document ${documentId}.`;
}

async function analyzeContent(content: string): Promise<string> {
  'use step';
  return `analysis of ${content.length} chars`;
}

async function generateSummary(analysis: string): Promise<string> {
  'use step';
  return `Summary: ${analysis}`;
}
