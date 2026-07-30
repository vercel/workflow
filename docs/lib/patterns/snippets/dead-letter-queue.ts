export const deadLetterQueueStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import {
  processWithDeadLetters,
  redriveDeadLetters,
  type QueueItem,
} from "@/app/workflows/dead-letter-queue-workflow";

// POST /api/dead-letter-queue { items: QueueItem[] }      — process a batch
// POST /api/dead-letter-queue { redrive: true, limit? }   — reprocess DLQ
export async function POST(request: Request) {
  const body = await request.json();

  if (body.redrive) {
    const run = await start(redriveDeadLetters, [body.limit ?? 100]);
    return NextResponse.json({ runId: run.runId, mode: "redrive" });
  }

  const items = body.items as QueueItem[];
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "items must be a non-empty array" },
      { status: 400 },
    );
  }

  const run = await start(processWithDeadLetters, [items]);
  return NextResponse.json({ runId: run.runId, mode: "process" });
}
`;
