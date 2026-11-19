import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The branch checked out in `cwd`, or `undefined` outside a git repository
 * or on a detached HEAD.
 */
export async function getCurrentGitBranch(
  cwd: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 5_000 }
    );
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}
