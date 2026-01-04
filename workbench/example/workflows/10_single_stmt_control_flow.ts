/**
 * Test workflow for single-statement control flow extraction.
 * These patterns test that steps inside if/while/for without braces
 * are correctly extracted into the workflow graph.
 */

async function singleStmtStepA(): Promise<string> {
  'use step';
  return 'A';
}

async function singleStmtStepB(): Promise<string> {
  'use step';
  return 'B';
}

async function singleStmtStepC(value: number): Promise<number> {
  'use step';
  return value * 2;
}

export async function single_statement_if() {
  'use workflow';

  const condition = true;

  // Single-statement if (no braces) - should be extracted
  if (condition) await singleStmtStepA();

  // Single-statement if-else (no braces) - both branches should be extracted
  if (condition) await singleStmtStepA();
  else await singleStmtStepB();

  return 'done';
}

export async function single_statement_while() {
  'use workflow';

  let counter = 0;

  // Single-statement while (no braces) - should be extracted with loop metadata
  // Note: This loop runs 5 times since counter starts at 0 and we check < 5
  while (counter++ < 5) await singleStmtStepA();

  return 'done';
}

export async function single_statement_for() {
  'use workflow';

  // Single-statement for loop (no braces) - should be extracted with loop metadata
  for (let i = 0; i < 3; i++) await singleStmtStepB();

  // Single-statement for-of loop (no braces) - should be extracted with loop metadata
  const items = [1, 2, 3];
  for (const item of items) await singleStmtStepC(item);

  return 'done';
}
