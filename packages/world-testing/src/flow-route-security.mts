import { expect, test } from 'vitest';
import { startServer } from './util.mjs';

export function flowRouteSecurity(world: string) {
  test('does not expose the flow handler over HTTP', async () => {
    const server = await startServer({ world });
    const url = `http://localhost:${server.info.port}/.well-known/workflow/v1/flow`;

    const [delivery, health] = await Promise.all([
      fetch(url, { method: 'POST', body: '{}' }),
      fetch(`${url}?__health`, { method: 'POST' }),
    ]);

    expect(delivery.status).toBe(404);
    expect(health.status).toBe(404);
  });
}
