import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, '../..');
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? path.resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
  : path.join(repositoryRoot, 'target');
const supportedTargets = new Set(['darwin/arm64', 'linux/x64', 'win32/x64']);
const currentTarget = `${process.platform}/${process.arch}`;
if (!supportedTargets.has(currentTarget)) {
  throw new Error(
    `@workflow/world-sqlite Phase 1 does not build for ${currentTarget}; ` +
      'supported targets are Linux x64 glibc, macOS arm64, and Windows x64.'
  );
}
if (process.platform === 'linux') {
  const glibcVersion = process.report.getReport().header.glibcVersionRuntime;
  const [major, minor] = String(glibcVersion ?? '')
    .split('.')
    .map(Number);
  if (
    !glibcVersion ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 2 ||
    (major === 2 && minor < 28)
  ) {
    throw new Error(
      '@workflow/world-sqlite Phase 1 requires glibc 2.28 or newer; musl is not supported.'
    );
  }
}
const artifactName =
  process.platform === 'win32'
    ? 'workflow_world_sqlite_node.dll'
    : process.platform === 'darwin'
      ? 'libworkflow_world_sqlite_node.dylib'
      : 'libworkflow_world_sqlite_node.so';

await execFileAsync(
  'cargo',
  ['build', '-p', 'workflow-world-sqlite-node', '--locked'],
  { cwd: repositoryRoot, encoding: 'utf8' }
);
await fs.copyFile(
  path.join(targetDirectory, 'debug', artifactName),
  path.join(packageDirectory, 'workflow-world-sqlite.node')
);
