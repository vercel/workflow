import { json, type RequestHandler } from '@sveltejs/kit';
import { start } from 'workflow/api';
import { handleUserSignup } from '../../../workflows/user-signup';

export const GET: RequestHandler = async ({
  request,
}: {
  request: Request;
}) => {
  const run = await start(handleUserSignup, ['test@example.com']);
  return json(run.runId);
};
