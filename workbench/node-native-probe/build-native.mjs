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
const artifactName =
  process.platform === 'win32'
    ? 'workflow_node_native_probe.dll'
    : process.platform === 'darwin'
      ? 'libworkflow_node_native_probe.dylib'
      : 'libworkflow_node_native_probe.so';

await execFileAsync(
  'cargo',
  ['build', '-p', 'workflow_node_native_probe', '--locked'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }
);
await fs.copyFile(
  path.join(targetDirectory, 'debug', artifactName),
  path.join(packageDirectory, 'workflow-node-native-probe.node')
);
