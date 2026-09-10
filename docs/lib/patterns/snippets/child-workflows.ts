export const childWorkflowsStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { processDocumentBatch } from "@/app/workflows/child-workflows-example";

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

export const childWorkflowsUsageSource = `import { start } from "workflow/api";
import { startAndWait } from "@/app/workflows/child-workflows";

// Inside any parent workflow: spawn children and await their typed results.
// Each child is its own run with its own retries, event log, and failure
// scope — Promise.allSettled keeps one failure from aborting the rest.
export async function importAllRepos(repoIds: string[]) {
  "use workflow";

  const results = await Promise.allSettled(
    repoIds.map((id) =>
      startAndWait<{ id: string; files: number }>(id, (token) =>
        spawnImportRepo(id, token),
      ),
    ),
  );

  return {
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

// start() runs in a step (v4-compatible). The child you spawn is YOUR
// workflow wrapped with withChildCompletionHook — see the Example tab.
async function spawnImportRepo(id: string, token: string): Promise<void> {
  "use step";
  await start(importRepoWithCompletion, [id, token]);
}
`;
