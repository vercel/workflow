import cp from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WorkflowRunSchema } from '@workflow/world';
import chalk, { type ChalkInstance } from 'chalk';
import jsonlines from 'jsonlines';
import { assert, onTestFailed, onTestFinished } from 'vitest';
import type { TypedHook } from 'workflow';
import * as z from 'zod';
import type manifest from '../.well-known/workflow/v1/manifest.json';

export const Control = z.object({
  state: z.literal('listening'),
  info: z.object({
    port: z.number(),
  }),
});
type Control = z.infer<typeof Control>;

type Files = keyof typeof manifest.workflows;
type Workflows<F extends Files> = keyof (typeof manifest.workflows)[F];

export async function startServer(opts: {
  world: string;
  env?: Record<string, string | undefined>;
}) {
  let serverPath = new URL('./server.mts', import.meta.url);

  if (!existsSync(serverPath)) {
    serverPath = new URL('./server.mjs', import.meta.url);
  }

  const proc = cp.spawn('node', [fileURLToPath(serverPath)], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: opts.world,
      CONTROL_FD: '3',
      ...(opts.env ?? {}),
    },
  });
  onTestFinished(() => {
    proc.kill();
  });

  const stdio = [] as { stream: ChalkInstance; chunk: string }[];
  // Accumulated raw server output — used by tests that want to inspect
  // debug logs (e.g., count runtime iterations, event loads, etc.).
  const outputBuffer: string[] = [];
  proc.stdout?.on('data', (chunk) => {
    const str = chunk.toString();
    stdio.push({ stream: chalk.white, chunk: str });
    outputBuffer.push(str);
  });
  proc.stderr?.on('data', (chunk) => {
    const str = chunk.toString();
    stdio.push({ stream: chalk.red, chunk: str });
    outputBuffer.push(str);
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
    const control = Control.parse(chunk);
    return {
      ...control,
      getOutput: () => outputBuffer.join(''),
    };
  }

  throw new Error('Server did not start correctly');
}

const Invoke = z.object({ runId: z.coerce.string() });

export function createFetcher(control: Control) {
  return {
    async invoke<F extends Files, W extends Workflows<F>>(
      file: F,
      workflow: W,
      args: unknown[]
    ) {
      const x = await fetch(`http://localhost:${control.info.port}/invoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ file, workflow, args }),
      });
      const data = await x.json().then(Invoke.parse);
      onTestFailed(() => {
        console.error('Workflow run:', data.runId);
      });
      return data;
    },
    async getFlowInvocationCount(runId: string): Promise<number> {
      const x = await fetch(
        `http://localhost:${control.info.port}/_flow-invocations/${encodeURIComponent(runId)}`
      );
      const data = (await x.json()) as { count: number };
      return data.count;
    },
    async getRun(id: string) {
      const x = await fetch(
        `http://localhost:${control.info.port}/runs/${encodeURIComponent(id)}`
      );
      const text = await x.text();
      // Custom JSON reviver to decode base64 back to Uint8Array
      const data = JSON.parse(text, (_key, value) => {
        if (
          value !== null &&
          typeof value === 'object' &&
          (value as any).__type === 'Uint8Array' &&
          typeof (value as any).data === 'string'
        ) {
          return new Uint8Array(Buffer.from((value as any).data, 'base64'));
        }
        return value;
      });
      return WorkflowRunSchema.parseAsync(data);
    },
    async getReadable(id: string): Promise<ReadableStream<Uint8Array>> {
      const x = await fetch(
        `http://localhost:${control.info.port}/runs/${encodeURIComponent(id)}/readable`
      );
      if (!x.ok) {
        throw new Error(
          `Failed to get readable stream: ${x.status} ${x.statusText}`
        );
      }
      if (!x.body) {
        throw new Error('No body in response');
      }
      return x.body;
    },
    async resumeHook<T extends TypedHook<any, any>>(
      token: string,
      payload: Omit<NoInfer<TypedHook.Input<T>>, 'metadata'>
    ) {
      const res = await fetch(
        `http://localhost:${control.info.port}/hooks/${token}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );
      res.arrayBuffer().catch(() => {}); // Drain the body to avoid resource leaks
      if (!res.ok) {
        throw new Error(
          `Failed to resume hook: ${res.status} ${res.statusText}`
        );
      }
    },
  };
}
