// biome-ignore-all format: the workflow stays on one line, the shape under test
import { Counter, doubleIt, steps, tripleIt } from './one-line-step-helpers.js';

// No directive in this file sits on a line of its own either.
export async function oneLineStepsWorkflow(n: number) { 'use workflow'; const a = await doubleIt(n); const b = await tripleIt(a); const c = await Counter.addOne(b); const d = await steps.squareIt(c); return { a, b, c, d }; }