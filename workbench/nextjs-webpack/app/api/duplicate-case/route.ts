// NOTE: This route isn't needed/ever used, we're just
//       using it because webpack relies on esbuild's tree shaking

import { start } from 'workflow/api';
import { addTenWorkflow } from '@/workflows/98_duplicate_case';

export async function GET(_: Request) {
  const run = await start(addTenWorkflow, [10]);
  const result = await run.returnValue;
  return Response.json({ result });
}
