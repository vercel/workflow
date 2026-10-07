import { createSnapshotsStorage as create } from '../../storage/snapshots.js';
import { dbFor } from '../db-cache.js';

export function createSnapshotsStorage(basedir: string) {
  return create({ db: dbFor(basedir), tag: '' });
}
