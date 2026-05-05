// Regression test: imports used by a step that gets hoisted out of a
// workflow body must NOT be stripped by dead-code elimination in step
// mode. Imports referenced only by the workflow body (which is replaced
// with a `throw` proxy) and truly unused imports should still be stripped.
import { db } from './db'; // used by hoisted step
import { unused } from './unused'; // should be stripped
import * as logger from './logger'; // used by hoisted step
import { tool, z } from 'some-agent-lib'; // only used by replaced workflow body, should be stripped

async function w() {
  'use workflow';
  const agent = new WorkflowAgent({
    model: 'anthropic/claude-opus-4.5',
    tools: () => ({
      queryDatabase: tool({
        description: 'Query the database',
        inputSchema: z.object({ query: z.string() }),
        execute: async (input) => {
          'use step';
          logger.info('querying', input.query);
          return db.query(input.query);
        },
      }),
    }),
  });
}
