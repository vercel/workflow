export async function* jsonlines(readable: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let buffer = '';

  const bufferedLines = () => {
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    return lines;
  };

  async function* bufferedObjects() {
    const lines = bufferedLines();
    for (const line of lines) {
      try {
        yield JSON.parse(line);
      } catch {}
    }
  }

  while (true) {
    const read = await reader.read();
    if (read.value) {
      const text = decoder.decode(read.value, { stream: true });
      buffer += text;
      yield* bufferedObjects();
    }
    if (read.done) {
      break;
    }
  }

  yield* bufferedObjects();
}
