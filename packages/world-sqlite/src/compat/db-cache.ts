// Test shim: world-local's suites address a store by directory; world-sqlite
// keeps one database file per directory, shared by every storage/streamer
// opened on it (as world-local's instances share the directory).
import path from 'node:path';
import { Db } from '../db.js';

const dbs = new Map<string, Db>();

export function dbFor(basedir: string): Db {
  const key = path.resolve(basedir);
  let db = dbs.get(key);
  if (!db || !db.isOpen) {
    db = new Db(path.join(key, 'workflow.sqlite'));
    dbs.set(key, db);
  }
  return db;
}
