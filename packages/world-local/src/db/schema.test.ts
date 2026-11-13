import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRawDatabase } from './driver.js';
import { DATABASE_FILE_NAME, databaseFor } from './index.js';
import { NewerSchemaError, SCHEMA_VERSION } from './schema.js';

describe('schema migrations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-schema-'));
  });
  afterEach(async () => {
    databaseFor(dir).close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migrates a new database to the current schema', () => {
    const db = databaseFor(dir);
    expect(db.get('PRAGMA user_version')).toEqual({
      user_version: SCHEMA_VERSION,
    });
  });

  it('refuses a database migrated by a newer release', () => {
    const raw = openRawDatabase(path.join(dir, DATABASE_FILE_NAME));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => databaseFor(dir).get('SELECT 1')).toThrow(NewerSchemaError);
  });
});
