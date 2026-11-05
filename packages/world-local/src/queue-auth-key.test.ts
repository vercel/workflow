import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearQueueAuthKeySources,
  generateQueueAuthKey,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
  resetGlobalSingletonForTest,
  verifyQueueAuthKey,
} from '@workflow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from './index.js';
import { MAX_QUEUE_AUTH_REFUSALS } from './queue.js';
import {
  createQueueAuthKey,
  QUEUE_AUTH_KEY_FILE,
  readQueueAuthKeyFile,
} from './queue-auth-key.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'queue-auth-key-'));
});

afterEach(() => {
  // A fresh process for the next test: no key held, no receiving-side source.
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  clearQueueAuthKeySources();
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

const keyFile = (dir: string) => path.join(dir, QUEUE_AUTH_KEY_FILE);
const readKey = (dir: string) => readFileSync(keyFile(dir), 'utf8').trim();

describe('the regenerating World (the app, a script calling start())', () => {
  it('writes a new key, owner-only, before it hands one to its queue', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();

    // Resolved only once written: the queue never sends a key the CLI or the
    // app's other processes cannot read yet.
    expect(readKey(dataDir)).toBe(key);
    expect(readFileSync(keyFile(dataDir), 'utf8')).toBe(`${key}\n`);
    if (process.platform !== 'win32') {
      expect(statSync(keyFile(dataDir)).mode & 0o777).toBe(0o600);
    }
    // Written through a temporary file renamed over it: none is left behind.
    expect(readdirSync(dataDir).sort()).toEqual(
      ['.gitignore', QUEUE_AUTH_KEY_FILE].sort()
    );
  });

  it('replaces the key of the previous run of the app', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    const previous = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${previous}\n`);

    const key = await createQueueAuthKey(dataDir, 'regenerate').current();

    expect(key).not.toBe(previous);
    expect(readKey(dataDir)).toBe(key);
  });

  it('regenerates once per process and directory (bundler layers, HMR)', async () => {
    const dataDir = path.join(base, 'data');
    const first = await createQueueAuthKey(dataDir, 'regenerate').current();
    const { ino, mtimeMs } = statSync(keyFile(dataDir));

    // Another World on the same directory in this process, and a fresh copy
    // of the module, as a second bundler layer or an HMR reload evaluates it.
    const second = await createQueueAuthKey(dataDir, 'regenerate').current();
    vi.resetModules();
    const reloaded = await import('./queue-auth-key.js');
    const third = await reloaded
      .createQueueAuthKey(dataDir, 'regenerate')
      .current();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(statSync(keyFile(dataDir))).toMatchObject({ ino, mtimeMs });
  });

  it('accepts the deliveries of two Worlds on different data directories in one process', async () => {
    // The runtime's check (verifyQueueAuthKey) behind a real HTTP route.
    const decisions: boolean[] = [];
    const server = createServer(async (request, response) => {
      for await (const _ of request);
      const ok = await verifyQueueAuthKey(
        request.headers[QUEUE_AUTH_HEADER] as string | undefined
      );
      decisions.push(ok);
      response.statusCode = ok ? 200 : 401;
      if (!ok) response.setHeader(QUEUE_AUTH_REFUSED_HEADER, '1');
      response.setHeader('content-type', 'application/json');
      response.end(
        ok ? '{}' : JSON.stringify({ code: QUEUE_AUTH_REFUSED_CODE })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const worlds = [
      createWorld({ dataDir: path.join(base, 'a'), baseUrl }),
      createWorld({ dataDir: path.join(base, 'b'), baseUrl }),
    ];
    try {
      for (const [i, world] of worlds.entries()) {
        await world.queue(
          '__wkf_workflow_test' as never,
          { runId: `wrun_${i}` } as never
        );
      }
      await vi.waitFor(() => expect(decisions).toHaveLength(2), {
        interval: 10,
      });
      // Both accepted on the first delivery: neither key was refused.
      expect(decisions).toEqual([true, true]);
      expect(readKey(path.join(base, 'a'))).not.toBe(
        readKey(path.join(base, 'b'))
      );
    } finally {
      await Promise.all(worlds.map((world) => world.close?.()));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps one key per data directory, and accepts each of them', async () => {
    const a = await createQueueAuthKey(
      path.join(base, 'a'),
      'regenerate'
    ).current();
    const b = await createQueueAuthKey(
      path.join(base, 'b'),
      'regenerate'
    ).current();
    expect(a).not.toBe(b);
    // Both Worlds' routes are this process's: either key is accepted, the
    // first World's too, not only the last one registered.
    expect(await verifyQueueAuthKey(a)).toBe(true);
    expect(await verifyQueueAuthKey(b)).toBe(true);
    expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
  });

  it('accepts its own key on every delivery without touching the file', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();
    rmSync(keyFile(dataDir));

    for (let i = 0; i < 1_000; i++) {
      expect(await verifyQueueAuthKey(key)).toBe(true);
    }
    // A reload would have written the key again: none happened.
    expect(existsSync(keyFile(dataDir))).toBe(false);
  });

  it('accepts a key another process of the app wrote, and sends it from then on', async () => {
    const dataDir = path.join(base, 'data');
    const own = createQueueAuthKey(dataDir, 'regenerate');
    const mine = await own.current();
    const theirs = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${theirs}\n`);

    expect(await verifyQueueAuthKey(theirs)).toBe(true);
    expect(await own.current()).toBe(theirs);
    // The key it held before is refused from now on: its in-flight senders
    // reload and retry with the file's key.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await verifyQueueAuthKey(mine)).toBe(false);
  });

  it('refuses a wrong key, reading the file at most every 250ms', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();
    const replaced = generateQueueAuthKey();

    // A flood of wrong keys: the first reloads, the rest within the interval
    // compare against memory only. So a key written meanwhile is not seen
    // until the interval has passed.
    expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
    writeFileSync(keyFile(dataDir), `${replaced}\n`);
    for (let i = 0; i < 100; i++) {
      expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
    }
    expect(await verifyQueueAuthKey(replaced)).toBe(false);
    expect(await verifyQueueAuthKey(key)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await verifyQueueAuthKey(replaced)).toBe(true);
  });

  it('writes its key again when the data directory was deleted, on the next keyless delivery', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();
    rmSync(dataDir, { recursive: true });

    // The CLI found no key file and sent none: refused, and the app's
    // reload put the key back for the CLI's own reload to find.
    expect(await verifyQueueAuthKey(undefined)).toBe(false);
    expect(readKey(dataDir)).toBe(key);
    expect(readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('writes back the same key, never a new one, however often keyless deliveries arrive', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();

    for (let round = 0; round < 3; round++) {
      rmSync(keyFile(dataDir));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await verifyQueueAuthKey(undefined)).toBe(false);
      expect(readKey(dataDir)).toBe(key);
    }
    // The key it accepts is still that one.
    expect(await verifyQueueAuthKey(key)).toBe(true);
  });

  it('rewrites the key file at most every 250ms under a flood of keyless deliveries', async () => {
    const dataDir = path.join(base, 'data');
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();

    // The first keyless delivery reloads and rewrites the deleted file.
    rmSync(keyFile(dataDir));
    expect(await verifyQueueAuthKey(undefined)).toBe(false);
    expect(readKey(dataDir)).toBe(key);

    // Within the interval, keyless (and empty, and malformed) deliveries
    // compare against memory only: a file deleted meanwhile stays deleted.
    rmSync(keyFile(dataDir));
    for (let i = 0; i < 100; i++) {
      for (const value of [undefined, '', 'not-a-key']) {
        expect(await verifyQueueAuthKey(value)).toBe(false);
      }
    }
    expect(existsSync(keyFile(dataDir))).toBe(false);

    // After the interval, the next one rewrites it, with the same key.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await verifyQueueAuthKey(undefined)).toBe(false);
    expect(readKey(dataDir)).toBe(key);
  });

  it('replaces a corrupt or empty key file with its own key', async () => {
    for (const content of ['', 'not-a-key\n', `${generateQueueAuthKey()}x`]) {
      resetGlobalSingletonForTest(
        '@workflow/world-local//queueAuthKeyFiles',
        1
      );
      const dataDir = mkdtempSync(path.join(base, 'data-'));
      const key = await createQueueAuthKey(dataDir, 'regenerate').current();
      writeFileSync(keyFile(dataDir), content);

      expect(await verifyQueueAuthKey(undefined)).toBe(false);
      expect(readKey(dataDir)).toBe(key);
      expect(await verifyQueueAuthKey(key)).toBe(true);
    }
  });

  it('still authenticates its own deliveries when the key cannot be written, and logs it once', async () => {
    // A data directory under a regular file: every write fails, as root too.
    const blocker = path.join(base, 'file');
    writeFileSync(blocker, '');
    const dataDir = path.join(blocker, 'data');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const own = createQueueAuthKey(dataDir, 'regenerate');
    const key = await own.current();

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyQueueAuthKey(key)).toBe(true);
    await own.reload();
    await own.restore();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(
      'Could not write the queue auth key'
    );
    // The CLI, another process, finds no key to send.
    resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
    expect(await createQueueAuthKey(dataDir, 'read').current()).toBeUndefined();
  });
});

describe('a reader (the CLI, the web UI, world-postgres)', () => {
  it('sends the key the app wrote', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    const key = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${key}\n`);

    expect(await createQueueAuthKey(dataDir, 'read').current()).toBe(key);
  });

  it('writes nothing, and creates no data directory', async () => {
    const dataDir = path.join(base, '.workflow-data');
    const reader = createQueueAuthKey(dataDir, 'read');

    expect(await reader.current()).toBeUndefined();
    expect(await reader.reload()).toBeUndefined();
    await reader.restore();
    expect(existsSync(dataDir)).toBe(false);

    mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
    expect(await reader.reload()).toBeUndefined();
    expect(readdirSync(dataDir)).toEqual(['runs']);
  });

  it('registers no receiving-side key source', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    const key = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${key}\n`);
    await createQueueAuthKey(dataDir, 'read').current();

    // Without a source the route checks the in-memory key, not the file.
    expect(await verifyQueueAuthKey(key)).toBe(false);
  });

  it('sends no key for a corrupt or empty key file', async () => {
    for (const content of ['', '\n', 'short', `${generateQueueAuthKey()}!`]) {
      resetGlobalSingletonForTest(
        '@workflow/world-local//queueAuthKeyFiles',
        1
      );
      const dataDir = mkdtempSync(path.join(base, 'data-'));
      writeFileSync(keyFile(dataDir), content);
      expect(
        await createQueueAuthKey(dataDir, 'read').current()
      ).toBeUndefined();
      expect(readFileSync(keyFile(dataDir), 'utf8')).toBe(content);
    }
  });

  it('keeps sending the key it read when the file is deleted, and picks up a new one on reload', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    const key = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${key}\n`);
    const reader = createQueueAuthKey(dataDir, 'read');
    expect(await reader.current()).toBe(key);

    rmSync(keyFile(dataDir));
    expect(await reader.current()).toBe(key);
    expect(await reader.reload()).toBe(key);
    expect(existsSync(keyFile(dataDir))).toBe(false);

    const next = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${next}\n`);
    expect(await reader.reload()).toBe(next);
  });
});

describe('world.clear()', () => {
  it('writes the same key again, so the CLI and the running app keep working', async () => {
    const dataDir = path.join(base, 'data');
    const world = createWorld({ dataDir });
    try {
      await world.start?.();
      // start() does not wait for the key write; this does (the same process
      // and directory: it returns the World's key, it does not make one).
      const key = await createQueueAuthKey(dataDir, 'regenerate').current();
      expect(readKey(dataDir)).toBe(key);
      expect(await verifyQueueAuthKey(key)).toBe(true);

      await world.clear();

      expect(readKey(dataDir)).toBe(key);
      expect(await verifyQueueAuthKey(key)).toBe(true);
      expect(await createQueueAuthKey(dataDir, 'read').current()).toBe(key);
    } finally {
      await world.close?.();
    }
  });
});

describe('deliveries, with real timers', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) =>
      server ? server.close(resolve) : resolve(undefined)
    );
    server = undefined;
  });

  type Decision = { key: string | undefined; accepted: boolean };

  /**
   * A flow route that accepts the key in `dataDir`'s file and answers anything
   * else with the runtime's marked 401. `decide` overrides that check. Each
   * delivery is recorded once it has been decided, with the outcome, so a
   * test can wait for a delivery to be accepted before it changes the file.
   */
  async function route(
    dataDir: string,
    decide: (key: string | undefined) => boolean | Promise<boolean> = async (
      key
    ) => key !== undefined && key === (await readQueueAuthKeyFile(dataDir))
  ) {
    const decisions: Decision[] = [];
    server = createServer(async (request, response) => {
      for await (const _ of request);
      const key = request.headers[QUEUE_AUTH_HEADER] as string | undefined;
      const accepted = await decide(key);
      decisions.push({ key, accepted });
      response.setHeader('content-type', 'application/json');
      if (accepted) {
        response.end('{}');
      } else {
        response.statusCode = 401;
        response.setHeader(QUEUE_AUTH_REFUSED_HEADER, '1');
        response.end(JSON.stringify({ code: QUEUE_AUTH_REFUSED_CODE }));
      }
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    return { decisions, baseUrl: `http://127.0.0.1:${port}` };
  }

  const accepted = (decisions: Decision[]) =>
    decisions.filter((decision) => decision.accepted).length;

  it("a starting app's first delivery carries its new key on the first attempt, without waiting", async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    writeFileSync(keyFile(dataDir), `${generateQueueAuthKey()}\n`);
    const { decisions, baseUrl } = await route(dataDir);
    const world = createWorld({ dataDir, baseUrl });
    try {
      const startedAt = Date.now();
      await world.queue(
        '__wkf_workflow_test' as never,
        { runId: 'wrun_1' } as never
      );
      await vi.waitFor(() => expect(decisions).toHaveLength(1), {
        interval: 10,
      });
      // Far below world-local's 5s retry backoff: nothing waited or retried.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(decisions).toEqual([{ key: readKey(dataDir), accepted: true }]);
    } finally {
      await world.close?.();
    }
  });

  it('a sender holding an old key retries at once with the new one after a refusal', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    const old = generateQueueAuthKey();
    writeFileSync(keyFile(dataDir), `${old}\n`);
    const { decisions, baseUrl } = await route(dataDir);
    const cli = createWorld({ dataDir, baseUrl, queueAuthKey: 'read' });
    try {
      // The CLI reads the key and its first delivery is accepted with it.
      await cli.queue(
        '__wkf_workflow_test' as never,
        { runId: 'wrun_1' } as never
      );
      await vi.waitFor(() => expect(accepted(decisions)).toBe(1), {
        interval: 10,
      });
      expect(decisions).toEqual([{ key: old, accepted: true }]);
      decisions.length = 0;

      // Only then does the app restart and write a new key.
      const fresh = generateQueueAuthKey();
      writeFileSync(keyFile(dataDir), `${fresh}\n`);

      const startedAt = Date.now();
      await cli.queue(
        '__wkf_workflow_test' as never,
        { runId: 'wrun_2' } as never
      );
      await vi.waitFor(() => expect(accepted(decisions)).toBe(1), {
        interval: 10,
      });
      expect(decisions).toEqual([
        { key: old, accepted: false },
        { key: fresh, accepted: true },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(readKey(dataDir)).toBe(fresh);
    } finally {
      await cli.close?.();
    }
  });

  it('a message refused on more rotations than the refusal limit is still delivered when each retry is fixed', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    writeFileSync(keyFile(dataDir), `${generateQueueAuthKey()}\n`);
    // Each of the first 7 deliveries meets a key that rotated just before
    // it arrived (an app restarting, scripts calling start()): refused, with
    // the new key already in the file for the sender's reload to find.
    const ROTATIONS = 7;
    let rotations = 0;
    const { decisions, baseUrl } = await route(dataDir, async (key) => {
      if (rotations < ROTATIONS) {
        rotations++;
        writeFileSync(keyFile(dataDir), `${generateQueueAuthKey()}\n`);
        return false;
      }
      return key !== undefined && key === (await readQueueAuthKeyFile(dataDir));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = createWorld({ dataDir, baseUrl, queueAuthKey: 'read' });
    try {
      const startedAt = Date.now();
      await cli.queue(
        '__wkf_workflow_test' as never,
        { runId: 'wrun_1' } as never
      );
      await vi.waitFor(() => expect(accepted(decisions)).toBe(1), {
        interval: 10,
        timeout: 5_000,
      });
      expect(decisions.filter((decision) => !decision.accepted)).toHaveLength(
        ROTATIONS
      );
      // More than MAX_QUEUE_AUTH_REFUSALS refusals, none counted: no backoff
      // and no give-up line.
      expect(ROTATIONS).toBeGreaterThan(MAX_QUEUE_AUTH_REFUSALS);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining('giving up the message'),
        expect.anything()
      );
    } finally {
      await cli.close?.();
    }
  });

  it('a sender that found no key file retries at once once the app has written one', async () => {
    const dataDir = path.join(base, 'data');
    mkdirSync(dataDir);
    // The app refuses the keyless delivery after writing its key (its reload
    // rewrites a missing file before it refuses).
    const appKey = generateQueueAuthKey();
    const { decisions, baseUrl } = await route(dataDir, (key) => {
      if (key === appKey) return true;
      writeFileSync(keyFile(dataDir), `${appKey}\n`);
      return false;
    });
    const cli = createWorld({ dataDir, baseUrl, queueAuthKey: 'read' });
    try {
      const startedAt = Date.now();
      await cli.queue(
        '__wkf_workflow_test' as never,
        { runId: 'wrun_1' } as never
      );
      await vi.waitFor(() => expect(accepted(decisions)).toBe(1), {
        interval: 10,
      });
      expect(decisions).toEqual([
        { key: undefined, accepted: false },
        { key: appKey, accepted: true },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await cli.close?.();
    }
  });
});
