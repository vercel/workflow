import express from 'express';
// Side-effect import to keep _workflows in Nitro's dependency graph for HMR
import '../_workflows.js';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));
app.use(express.raw({ type: 'application/octet-stream' }));

app.post('/api/test-direct-step-call', async (req, res) => {
  // This route tests calling step functions directly outside of any workflow context
  // After the SWC compiler changes, step functions in client mode have their directive removed
  // and keep their original implementation, allowing them to be called as regular async functions
  // Import from 98_duplicate_case.ts to avoid path alias imports
  const { add } = await import('../workflows/98_duplicate_case.js');

  const { x, y } = req.body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return res.json({ result });
});

export default app;
