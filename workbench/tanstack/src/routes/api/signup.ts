import { createFileRoute } from '@tanstack/react-router';
import { start } from 'workflow/api';
import { handleUserSignup } from 'workflows/user-signup';

export const Route = createFileRoute('/api/signup')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const run = await start(handleUserSignup, ['test@example.com']);
        return Response.json(run);
      },
    },
  },
});
