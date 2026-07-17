import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export async function multipleViolationsWorkflow() {
  'use workflow';
  const content = readFileSync(join('/', 'package.json'), 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  return hash;
}
