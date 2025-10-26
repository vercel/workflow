import cp from 'node:child_process';
import { existsSync } from 'node:fs';
import { WorkflowRunSchema } from '@workflow/world';
import chalk, { type ChalkInstance } from 'chalk';
import jsonlines from 'jsonlines';
import { assert, onTestFailed, onTestFinished } from 'vitest';
import * as z from 'zod';
import type manifest from '../.well-known/workflow/v1/manifest.debug.json';

export const Control = z.object({
  state: z.literal('listening'),
  info: z.object({
    port: z.number(),
  }),
});
type Control = z.infer<typeof Control>;

type Files = keyof typeof manifest.workflows;
type Workflows<F extends Files> = keyof (typeof manifest.workflows)[F];

export const Worlds = {
  embedded: 'embedded',
  postgres: '@workflow/world-postgres',
};

export async function startServer(opts: { world: string }) {
  let serverPath = new URL('./server.mts', import.meta.url).pathname;

  if (!existsSync(serverPath)) {
    serverPath = new URL('./server.mjs', import.meta.url).pathname;
  }

  const proc = cp.spawn('node', [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: opts.world,
      CONTROL_FD: '3',
    },
  });
  onTestFinished(() => {
    proc.kill();
  });

  const stdio = [] as { stream: ChalkInstance; chunk: string }[];
  proc.stdout?.on('data', (chunk) => {
    stdio.push({ stream: chalk.white, chunk: chunk.toString() });
  });
  proc.stderr?.on('data', (chunk) => {
    stdio.push({ stream: chalk.red, chunk: chunk.toString() });
  });

  onTestFailed(() => {
    console.log('=== SERVER STDIO ===');
    let buffer = '';
    for (const { stream, chunk } of stdio) {
      buffer += stream.inverse(chunk);
    }
    console.log(buffer);
  });

  const fd3 = proc.stdio[3];
  assert(fd3, 'fd3 should be defined');

  for await (const chunk of fd3.pipe(jsonlines.parse())) {
    return Control.parse(chunk);
  }

  throw new Error('Server did not start correctly');
}

const Invoke = z.object({ runId: z.coerce.string() });

export function createFetcher(control: Control) {
  return {
    async invoke<F extends Files, W extends Workflows<F>>(
      file: F,
      workflow: W,
      args: unknown[],
      runId?: string
    ) {
      const x = await fetch(`http://localhost:${control.info.port}/invoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ file, workflow, args, runId }),
      });
      const data = await x.json().then(Invoke.parse);
      return data;
    },
    async getRun(id: string) {
      const x = await fetch(
        `http://localhost:${control.info.port}/runs/${encodeURIComponent(id)}`
      );
      const data = await x.json();
      return WorkflowRunSchema.parseAsync(data);
    },
  };
}
