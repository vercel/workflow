import { stepWithImportedHelper } from '../../workflows/_direct_call_step';

export async function POST({ request }: { request: Request }) {
  const body = await request.json();
  const { a, b } = body;

  const result = await stepWithImportedHelper(a, b);

  return Response.json({ result });
}

export const prerender = false;
