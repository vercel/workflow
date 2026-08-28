import { basename } from 'node:path';

export function appendDatabaseName(url: string, path: string): string {
  return `${url}/${basename(path)}`;
}
