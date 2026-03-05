import { defineEventHandler, readRawBody } from 'h3';
import { stepWithImportedHelper } from '../../workflows/_direct_call_step.js';

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const { a, b } = body;

  const result = await stepWithImportedHelper(a, b);

  return { result };
});
