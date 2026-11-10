import 'workflow/next/inline';
import { resumeHook } from 'workflow/api';
import { processInstanceId } from '@/workflows/inline_start';

/** Resumes `inlineHookWorkflow`'s hook, inline unless `inline: false`. */
export async function POST(req: Request) {
  const { token, inline = true } = (await req.json()) as {
    token: string;
    inline?: boolean;
  };
  const resumedAt = Date.now();
  await resumeHook(token, { resumedAt }, { experimental_inline: inline });
  return Response.json({
    resumedAt,
    resumeReturnedAt: Date.now(),
    instance: processInstanceId(),
  });
}
