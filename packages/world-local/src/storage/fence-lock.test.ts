/**
 * The cross-process fence lock behind world-local's in-band fence: one
 * holder at a time, a lock left by a holder that died is taken over at once
 * when its pid can be checked and after 30 s of staleness otherwise, and a
 * holder that loses its lock fails its write as lost.
 */

import { type ChildProcess, fork, spawn, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowWorldError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFenceFileLock } from './fence-lock.js';

let testDir: string;
let lockDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-fence-lock-'));
  lockDir = path.join(testDir, 'wrun_test.in-band.lock');
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await fs.rm(testDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

function pidNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/** A lock directory as a holder that went away left it. */
async function leaveLock(
  owner?: { pid: number; host?: string },
  ageMs = 0
): Promise<void> {
  await fs.mkdir(lockDir);
  if (owner) {
    const ns = pidNamespace();
    await fs.writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        pid: owner.pid,
        host: owner.host ?? os.hostname(),
        ...(ns !== undefined ? { pidNamespace: ns } : {}),
        token: 'left-behind',
      })
    );
  }
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await fs.utimes(lockDir, then, then);
  }
}

/** Whether `promise` is still pending after `ms`. */
async function pendingAfter(promise: Promise<unknown>, ms: number) {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    sleep(ms).then(() => false),
  ]);
  return !settled;
}

const childScript = fileURLToPath(
  new URL('./fence-lock.child.mjs', import.meta.url)
);

function spawnChild(args: string[]): ChildProcess {
  const child = fork(childScript, args, {
    // Node's own type stripping, nothing inherited from the test runner.
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  return child;
}

const nextMessage = (child: ChildProcess) =>
  new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) =>
      reject(new Error(`child exited (${code}) without answering`))
    );
  });

/** The `enter <pid>` / `exit <pid>` lines a `loop` child logs. */
async function readHolderLog(logPath: string) {
  return (await fs.readFile(logPath, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [what, pid] = line.split(' ');
      return { what, pid: Number(pid) };
    });
}

const enters = (lines: { what: string }[]) =>
  lines.filter((l) => l.what === 'enter').length;

/**
 * A holder enters only when nobody holds the lock, or when its holder was
 * killed while holding it.
 */
function expectOneHolderAtATime(
  lines: { what: string; pid: number }[],
  killed: Set<number>
) {
  let holder: number | undefined;
  for (const { what, pid } of lines) {
    if (what === 'enter') {
      if (holder !== undefined) expect(killed.has(holder)).toBe(true);
      holder = pid;
    } else {
      expect(holder).toBe(pid);
      holder = undefined;
    }
  }
}

describe('fence file lock (world-local)', () => {
  it('holds the lock directory, naming its holder, only while fn runs', async () => {
    const result = await withFenceFileLock(lockDir, 'wrun_test', async () => {
      const owner = JSON.parse(
        await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')
      );
      expect(owner).toMatchObject({ pid: process.pid, host: os.hostname() });
      return 'done';
    });
    expect(result).toBe('done');
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets one holder in at a time, also while taking over a dead holder', async () => {
    await leaveLock({ pid: deadPid() });
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFenceFileLock(lockDir, 'wrun_test', async () => {
          inside++;
          most = Math.max(most, inside);
          await sleep(5);
          inside--;
        })
      )
    );
    expect(most).toBe(1);
    const left = await fs.readdir(testDir);
    expect(left).toEqual([]);
  });

  it('takes over at once the lock of a holder that was SIGKILLed', async () => {
    const child = spawnChild(['hold', lockDir]);
    expect(await nextMessage(child)).toBe('held');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const started = Date.now();
    await withFenceFileLock(lockDir, 'wrun_test', async () => {});
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('waits for a live holder in another process', async () => {
    const child = spawnChild(['hold', lockDir]);
    expect(await nextMessage(child)).toBe('held');
    let acquired = false;
    const mine = withFenceFileLock(lockDir, 'wrun_test', async () => {
      acquired = true;
    });
    expect(await pendingAfter(mine, 1_500)).toBe(true);
    expect(acquired).toBe(false);
    const released = nextMessage(child);
    child.send('release');
    expect(await released).toBe('released');
    await mine;
    expect(acquired).toBe(true);
  });

  describe('a lock whose holder cannot be checked', () => {
    const cases = {
      // A restarted process that got the dead holder's pid back.
      'its pid is this process': () => leaveLock({ pid: process.pid }),
      // A live process that reused the pid (pid 1 would not do: there is
      // none on Windows).
      'its pid is alive': () => {
        const other = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1e3)'],
          {
            stdio: 'ignore',
          }
        );
        children.push(other);
        return leaveLock({ pid: other.pid as number });
      },
      'it was taken on another host': () =>
        leaveLock({ pid: deadPid(), host: 'another-host' }),
      'it names no holder (an older world-local)': () => leaveLock(),
    };
    for (const [name, leave] of Object.entries(cases)) {
      it(`is not taken over while fresh when ${name}`, async () => {
        await leave();
        const mine = withFenceFileLock(lockDir, 'wrun_test', async () => {});
        expect(await pendingAfter(mine, 500)).toBe(true);
        // The holder releases.
        await fs.rm(lockDir, { recursive: true, force: true });
        await mine;
      });
    }

    it('is taken over once its mtime is 30s old', async () => {
      await leaveLock({ pid: process.pid }, 31_000);
      const started = Date.now();
      await withFenceFileLock(lockDir, 'wrun_test', async () => {});
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it('fails a write whose lock was taken over, and leaves the new holder its lock', async () => {
    const error = await withFenceFileLock(lockDir, 'wrun_test', async () => {
      // Another writer took the lock over meanwhile.
      await fs.rm(lockDir, { recursive: true, force: true });
      await leaveLock({ pid: process.pid });
      return 'published';
    }).catch((err: unknown) => err);
    expect(WorkflowWorldError.is(error)).toBe(true);
    expect((error as Error).message).toMatch(/was lost while a write held it/);
    const owner = JSON.parse(
      await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')
    );
    expect(owner.token).toBe('left-behind');
  });

  it('keeps one holder at a time across processes that are SIGKILLed while holding it', async () => {
    // The loop runs until enough has happened, not for a fixed time: on a
    // loaded CI runner (Windows, next to storage.test.ts) a few seconds can
    // see under 20 acquisitions. The deadline also leaves room for one 30 s
    // stall: a holder killed between its mkdir and its owner write leaves a
    // lock with no owner, which only goes stale.
    const minEnters = 100;
    const minKills = 12;
    const deadline = Date.now() + 45_000;
    const logPath = path.join(testDir, 'holders.log');
    const killed = new Set<number>();
    const unexpectedExits: number[] = [];
    const start = async () => {
      const child = spawnChild(['loop', lockDir, logPath]);
      child.once('exit', (code, signal) => {
        if (signal !== 'SIGKILL') unexpectedExits.push(code ?? -1);
      });
      expect(await nextMessage(child)).toBe('ready');
      return child;
    };
    const running = await Promise.all([1, 2, 3, 4].map(start));
    let kills = 0;
    while (
      (kills < minKills || enters(await readHolderLog(logPath)) < minEnters) &&
      Date.now() < deadline
    ) {
      await sleep(100 + Math.random() * 100);
      const i = Math.floor(Math.random() * running.length);
      killed.add(running[i].pid as number);
      running[i].kill('SIGKILL');
      kills++;
      running[i] = await start();
    }
    for (const child of running) {
      killed.add(child.pid as number);
      child.kill('SIGKILL');
    }
    expect(unexpectedExits).toEqual([]);

    const lines = await readHolderLog(logPath);
    expectOneHolderAtATime(lines, killed);
    expect(kills).toBeGreaterThanOrEqual(minKills);
    expect(enters(lines)).toBeGreaterThanOrEqual(minEnters);
  }, 60_000);
});
