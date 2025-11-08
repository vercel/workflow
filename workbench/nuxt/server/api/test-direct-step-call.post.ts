// This route tests calling step functions directly outside of any workflow context
// After the SWC compiler changes, step functions in client mode have their directive removed
// and keep their original implementation, allowing them to be called as regular async functions

import { defineEventHandler, readRawBody } from 'h3';
import { add } from '../../workflows/99_e2e.js';

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const { x, y } = body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return { result };
});
