export const singletonRunUsageSource = `import { start } from "workflow/api";
import {
  getOrStart,
  sendToSingleton,
  userSession,
} from "@/app/workflows/singleton-run-workflow";

// POST /api/sessions/[userId]/tasks — feed work to the user's single
// live session, starting it on first use.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const { task } = await request.json();
  const key = \`user-session:\${userId}\`;

  const { runId, started } = await getOrStart(key, () =>
    start(userSession, [userId]),
  );

  await sendToSingleton(key, { type: "task", payload: task });

  return Response.json({ runId, started });
}
`;
