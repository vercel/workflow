import { Hono } from 'hono';
// Side-effect import to keep _workflows in Nitro's dependency graph for HMR
import '../_workflows.js';

const app = new Hono();

app.post('/api/test-direct-step-call', async ({ req }) => {
  // This route tests calling step functions directly outside of any workflow context
  // After the SWC compiler changes, step functions in client mode have their directive removed
  // and keep their original implementation, allowing them to be called as regular async functions
  // Import from 98_duplicate_case.ts to avoid path alias imports
  const { add } = await import('../workflows/98_duplicate_case.js');

  const body = await req.json();
  const { x, y } = body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return Response.json({ result });
});

export default app;
