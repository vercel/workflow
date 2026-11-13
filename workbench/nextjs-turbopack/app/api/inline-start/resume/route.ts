import { resumeHook } from 'workflow/api';
import { processInstanceId } from '@/workflows/inline_start';

/**
 * Resumes `inlineHookWorkflow`'s hook. On a World that can hold queue
 * messages, `resumeHook()` runs the woken orchestrator delivery here.
 */
export async function POST(req: Request) {
  const { token } = (await req.json()) as { token: string };
  const resumedAt = Date.now();
  await resumeHook(token, { resumedAt });
  return Response.json({
    resumedAt,
    resumeReturnedAt: Date.now(),
    instance: processInstanceId(),
  });
}
