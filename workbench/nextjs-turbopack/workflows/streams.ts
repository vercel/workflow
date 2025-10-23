import { xxh32 } from '@node-rs/xxhash';

// TODO: HMR should work if you have a step only file and
// add a workflow to it
export async function stremWorkflow() {
  'use workflow';
  return 'hi';
}

/**
 * Durable version of the add function
 */
export async function pumpData(writable: WritableStream) {
  'use step';
  console.log('pumpData', writable);

  const hash = xxh32('hello', 1);
  console.log('native hash', hash);

  const writer = writable.getWriter();
  await writer.write('first');

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await writer.write('second');

  return true;
}

export async function write(
  writable: WritableStream<Uint8Array>,
  data: string,
  eof = false
) {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(data));
  if (eof) {
    writer.close();
  }
}
