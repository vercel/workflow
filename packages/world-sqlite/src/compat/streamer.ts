import { createStreamer as createSqliteStreamer } from '../streamer.js';
import { dbFor } from './db-cache.js';

export function createStreamer(basedir: string, tag?: string) {
  return createSqliteStreamer(dbFor(basedir), tag);
}
