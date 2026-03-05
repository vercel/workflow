import type { RequestHandler } from '@sveltejs/kit';
import { stepWithImportedHelper } from '../../../workflows/_direct_call_step';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const { a, b } = body;

  const result = await stepWithImportedHelper(a, b);

  return Response.json({ result });
};
