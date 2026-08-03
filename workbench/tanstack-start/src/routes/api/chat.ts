// HMR sentinel route. The dev test suite watches that touching the imported
// workflow file rebuilds this handler. We use a dynamic import here (rather than
// the static `import * as workflows from '...'` used by other workbench apps)
// so the workflow module isn't pulled into this route's chunk in production —
// see the comment in test-direct-step-call.ts for why that matters here.

import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async () => {
        const workflows = await import('../../../workflows/3_streams.js');
        console.log(workflows);
        return json('hello world');
      },
    },
  },
});
