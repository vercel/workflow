import { Buffer } from 'node:buffer';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { createStorage } from './storage.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

function fixture() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const storage = createStorage({ token: 'test', dispatcher: agent });
  const list = async (version?: string) => {
    agent
      .get(ORIGIN)
      .intercept({ path: /\/api\/v4\/runs\/wrun_1\/events\?/, method: 'GET' })
      .reply(
        200,
        Buffer.from(encodeFrame({ _end: 1, hasMore: false }, new Uint8Array())),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            ...(version === undefined
              ? {}
              : { 'x-wf-hook-batch-version': version }),
          },
        }
      );
    await storage.events.list({ runId: 'wrun_1' });
  };
  return { agent, storage, list };
}

describe('server-negotiated system hook batching', () => {
  it('keeps individual registrations before setup and on older servers', async () => {
    const { agent, storage, list } = fixture();
    try {
      expect(storage.events.createHooks).toBeUndefined();
      await list();
      expect(storage.events.createHooks).toBeUndefined();
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  it('enables only the supported version and revokes it after a rollback', async () => {
    const { agent, storage, list } = fixture();
    const other = createStorage();
    try {
      await list('1');
      expect(storage.events.createHooks).toBeTypeOf('function');
      expect(other.events.createHooks).toBeUndefined();
      await list('2');
      expect(storage.events.createHooks).toBeUndefined();
      await list('1');
      expect(storage.events.createHooks).toBeTypeOf('function');
      await list();
      expect(storage.events.createHooks).toBeUndefined();
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  it('never falls back to individual writes after a batch is sent', async () => {
    const { agent, storage, list } = fixture();
    try {
      await list('1');
      agent
        .get(ORIGIN)
        .intercept({
          path: '/api/v4/runs/wrun_1/events/hooks/batch',
          method: 'POST',
        })
        .reply(404, encode({ error: 'not-found', message: 'Route missing' }));
      await expect(
        storage.events.createHooks?.(
          'wrun_1',
          [1, 2].map((i) => ({
            event: {
              eventType: 'hook_created' as const,
              correlationId: `hook_${i}`,
              eventData: { token: `abrt_${i}`, isSystem: true },
            },
          }))
        )
      ).rejects.toThrow('Route missing');
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });
});
