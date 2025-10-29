import { start } from 'workflow/api';
import { handleUserSignup } from '../../../workflows/user-signup.js';

export const GET = async () => {
  const run = await start(handleUserSignup, ['test@example.com']);

  return new Response(String(run.runId));
};
