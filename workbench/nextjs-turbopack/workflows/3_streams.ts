export async function genStream(): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (let i = 0; i < 30; i++) {
        const chunk = encoder.encode(`${i}\n`);
        controller.enqueue(chunk);
        console.log(`Enqueued number: ${i}`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      controller.close();
    },
  });
  return stream;
}

export async function consumeStreams(
  ...streams: ReadableStream<Uint8Array>[]
): Promise<string> {
  'use step';
  const parts: Uint8Array[] = [];

  console.log('Consuming streams', streams);

  await Promise.all(
    streams.map(async (s, i) => {
      const reader = s.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        console.log(
          `Received ${result.value.length} bytes from stream ${i}: ${JSON.stringify(new TextDecoder().decode(result.value))}`
        );
        parts.push(result.value);
      }
    })
  );

  return Buffer.concat(parts).toString('utf8');
}

export async function streams() {
  'use workflow';

  console.log('Streams workflow started');

  const [s1, s2] = await Promise.all([genStream(), genStream()]);
  const result = await consumeStreams(s1, s2);

  console.log(`Streams workflow completed. Result: ${result.slice(0, 100)}`);

  return {
    message: 'Streams processed successfully',
    dataLength: result.length,
    preview: result.slice(0, 100),
  };
}
