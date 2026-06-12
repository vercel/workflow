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
