export const batchingStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { batchImport, type ImportRecord } from "@/app/workflows/batching";

// POST /api/batching { records: ImportRecord[], batchSize?: number }
export async function POST(request: Request) {
  const { records, batchSize } = (await request.json()) as {
    records: ImportRecord[];
    batchSize?: number;
  };

  if (!Array.isArray(records) || records.length === 0) {
    return NextResponse.json(
      { error: "records must be a non-empty array" },
      { status: 400 },
    );
  }

  const run = await start(batchImport, [records, batchSize ?? 10]);
  return NextResponse.json({ runId: run.runId });
}
`;
