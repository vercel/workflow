import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQueueAuthKey, QUEUE_AUTH_KEY_FILE } from './queue-auth-key.js';

describe('queue auth key file: .gitignore', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'queue-auth-key-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('the regenerating World adds one to an existing data directory that has none', async () => {
    // A `.workflow-data` from a release that wrote no `.gitignore`.
    const dataDir = path.join(base, '.workflow-data');
    mkdirSync(path.join(dataDir, 'runs'), { recursive: true });

    const key = await createQueueAuthKey(dataDir, 'regenerate').current();

    expect(readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(path.join(dataDir, QUEUE_AUTH_KEY_FILE), 'utf8')).toBe(
      `${key}\n`
    );
  });

  it('a reader writes nothing into the data directory', async () => {
    const dataDir = path.join(base, '.workflow-data');
    mkdirSync(path.join(dataDir, 'runs'), { recursive: true });

    const reader = createQueueAuthKey(dataDir, 'read');

    expect(await reader.current()).toBeUndefined();
    expect(await reader.reload()).toBeUndefined();
    expect(readdirSync(dataDir)).toEqual(['runs']);
  });
});
