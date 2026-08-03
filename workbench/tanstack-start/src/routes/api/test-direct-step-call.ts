// This route tests calling step functions directly outside of any workflow context.
// After the SWC compiler changes, step functions in client mode have their directive
// removed and keep their original implementation, allowing them to be called as
// regular async functions.
//
// The step is defined inline rather than imported from workflows/99_e2e.ts because
// TanStack Start bundles all `src/routes/**` files together. Statically importing a
// workflow file pulls its class definitions (Counter, etc.) into this chunk, where
// the SWC plugin re-emits class-registration IIFEs under this app's host. Combined
// with the canonical registrations under the source-file host, the second
// `Object.defineProperty(cls, "classId", { configurable: false })` then throws at
// module-load time.

import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';

async function add(a: number, b: number) {
  'use step';
  return a + b;
}

export const Route = createFileRoute('/api/test-direct-step-call')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const { x, y } = body;

        console.log(`Calling step function directly with x=${x}, y=${y}`);

        const result = await add(x, y);
        console.log(`add(${x}, ${y}) = ${result}`);

        return json({ result });
      },
    },
  },
});
