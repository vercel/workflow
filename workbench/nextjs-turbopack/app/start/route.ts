import { getRun, start } from 'workflow/api';
import { test } from '@/workflows/t';

let runId: string | null = null;

export async function GET() {
  const run = await start(test);
  runId = run.runId;
  return new Response(runId);
  //return new Response(
  //  run.readable.pipeThrough(
  //    new TransformStream({
  //      transform(chunk, controller) {
  //        //console.log('chunk', chunk);
  //        if (chunk.type === 'text-delta') {
  //          controller.enqueue(chunk.delta);
  //        }
  //      },
  //    })
  //  )
  //);
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  console.log(searchParams);
  if (!runId) {
    return new Response('No runId provided', { status: 400 });
  }
  const run = getRun(runId);
  return new Response(
    run.getReadable({
      startIndex: parseInt(searchParams.get('startIndex') || '0'),
    })
  );
}

//export async function GET() {
//  return new Response('Hello, world!');
//}
