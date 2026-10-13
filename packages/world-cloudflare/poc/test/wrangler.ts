/** Start and stop `wrangler dev` for the POC Worker (local workerd only). */
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pocDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WRANGLER =
  process.env.WRANGLER_BIN ?? 'npx --yes wrangler@4.146.0';

export interface DevServer {
  url: string;
  stop(): Promise<void>;
  output(): string;
}

export async function startDev(
  port: number,
  persistTo: string
): Promise<DevServer> {
  let output = '';
  const child: ChildProcess = spawn(
    `${WRANGLER} dev --config wrangler.jsonc --port ${port} --persist-to ${persistTo} --show-interactive-dev-session=false`,
    {
      cwd: pocDir,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const deadline = Date.now() + 120_000;
  while (!output.includes('Ready on')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`wrangler dev did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    url: `http://localhost:${port}`,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      // Kill the whole process group: wrangler, its workerd, and the shell.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await exited;
    },
  };
}
