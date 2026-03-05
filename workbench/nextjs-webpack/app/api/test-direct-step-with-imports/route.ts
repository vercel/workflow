import { stepWithImportedHelper } from '@/workflows/_direct_call_step';

export async function POST(req: Request) {
  const body = await req.json();
  const { a, b } = body;

  const result = await stepWithImportedHelper(a, b);

  return Response.json({ result });
}
