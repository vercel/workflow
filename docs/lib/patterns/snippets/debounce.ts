export const debounceUsageSource = `import { debounceSend } from "@/app/workflows/debounce-workflow";

// In an API route or server action — e.g. on every document edit:
export async function POST(request: Request) {
  const { docId, editorId } = await request.json();

  // However many edits arrive, the index rebuild fires once, 30s after
  // the burst goes quiet.
  await debounceSend(\`reindex:\${docId}\`, { docId, lastEditor: editorId });

  return Response.json({ ok: true });
}
`;
