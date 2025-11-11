import { start } from 'workflow/api';
import { addTenWorkflow } from '@/workflows/98_duplicate_case';

export async function GET(req: Request) {
  const run = await start(addTenWorkflow, [10]);
  const result = await run.returnValue;
  return Response.json({ result });
}
