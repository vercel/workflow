import type { RequestHandler } from '@sveltejs/kit';
import { start } from 'workflow/api';
import { handleUserSignup } from '../../../../workflows/user-signup.js';

export const POST: RequestHandler = async ({ request }) => {
  const { email } = await request.json();
  // Executes asynchronously and doesn't block your app
  await start(handleUserSignup, [email]);
  return new Response(
    JSON.stringify({
      message: 'User signup workflow started',
    })
  );
};
