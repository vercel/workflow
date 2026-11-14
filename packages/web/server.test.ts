// @vitest-environment node
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'workflow-web-server-'));
  await mkdir(path.join(fixture, 'build/server'), { recursive: true });
  await mkdir(path.join(fixture, 'node_modules'));
  await symlink(
    path.resolve('node_modules/srvx'),
    path.join(fixture, 'node_modules/srvx'),
    'junction'
  );
  await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
  // Exercise the actual HTTP listener without building the UI.
  await writeFile(
    path.join(fixture, 'build/server/index.js'),
    'export const createFetchHandler = () => () => new Response("fixture");'
  );
  for (const file of ['server.js', 'static.js']) {
    await copyFile(path.resolve(file), path.join(fixture, file));
  }
  await writeFile(
    path.join(fixture, 'probe.mjs'),
    `import { startServer } from './server.js';
const server = await startServer();
try {
  console.log(JSON.stringify(server.node.server.address()));
} finally {
  await server.close();
}`
  );
});

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('production server listener', () => {
  it.each<[string | undefined, string | RegExp, boolean]>([
    [undefined, '127.0.0.1', false],
    ['', '127.0.0.1', false],
    ['localhost', /^(127\.0\.0\.1|::1)$/, false],
    ['0.0.0.0', '0.0.0.0', true],
  ])('binds with HOST=%s', async (host, address, warning) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
    delete env.HOST;
    if (host !== undefined) env.HOST = host;
    const { stdout, stderr } = await exec(
      process.execPath,
      [path.join(fixture, 'probe.mjs')],
      { env, timeout: 10_000 }
    );
    const listener = JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');
    if (typeof address === 'string') {
      expect(listener.address).toBe(address);
    } else {
      expect(listener.address).toMatch(address);
    }
    expect(listener.port).toBeGreaterThan(0);
    expect(stderr.includes('no built-in authentication')).toBe(warning);
  });
});
