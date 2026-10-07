import { createStorage as createSqliteStorage } from '../storage/index.js';
import { dbFor } from './db-cache.js';

export function createStorage(basedir: string, tag?: string) {
  return { ...createSqliteStorage(dbFor(basedir), tag), clearCache() {} };
}
