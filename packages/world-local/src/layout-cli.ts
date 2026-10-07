import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  convertLayout,
  DataDirLayoutError,
  describeConversion,
  findStrayFlatFiles,
  LAYOUT_MARKER_FILE,
} from './storage/layout.js';

const USAGE = `usage: workflow-local-layout <command> <dataDir> [--quarantine]

Commands:
  status    Print the data directory's layout as JSON.
  migrate   Store events and steps in one directory per run.
  flatten   Move them back to the flat layout releases before run-scoped
            storage read. Run it before downgrading, with the current
            package still installed.

Stop every process using the data directory (dev server, CLI, web UI,
vitest) first. Processes of this package that have it open are detected and
the conversion refuses; processes of older releases cannot be detected.

  --quarantine  Move files that cannot be placed (a different file already
                at the destination, or a flat file whose run cannot be
                determined) into <dataDir>/.layout/quarantine/ so the
                conversion can complete.

Exit codes: 0 done, 1 incomplete (files left in place, listed on stderr),
2 usage or other error, 3 refused (the data directory is in use).`;

/**
 * `workflow-local-layout`: inspect or convert a data directory's layout.
 * Diagnostics go to stderr; only `status` writes stdout (JSON).
 */
export async function runLayoutCli(
  argv: string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
  } = {
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
  }
): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const [command, dataDir, ...extra] = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--quarantine' && f !== '--help');
  if (
    flags.includes('--help') ||
    !command ||
    !dataDir ||
    extra.length > 0 ||
    unknown.length > 0 ||
    !['status', 'migrate', 'flatten'].includes(command)
  ) {
    io.stderr(USAGE);
    return flags.includes('--help') ? 0 : 2;
  }
  const dir = path.resolve(dataDir);
  try {
    await fs.access(dir);
  } catch {
    io.stderr(`${dir} does not exist`);
    return 2;
  }
  try {
    if (command === 'status') {
      let marker: unknown = null;
      try {
        marker = JSON.parse(
          await fs.readFile(path.join(dir, LAYOUT_MARKER_FILE), 'utf8')
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const state =
        marker && typeof marker === 'object' && 'state' in marker
          ? (marker as { state: unknown }).state
          : null;
      io.stdout(
        JSON.stringify({
          dataDir: dir,
          layout: state === null ? 'flat' : state,
          strayFlatFiles:
            state === 'run-scoped' ? (await findStrayFlatFiles(dir)).length : 0,
        })
      );
      return 0;
    }
    const report = await convertLayout(
      dir,
      command === 'migrate' ? 'run-scoped' : 'flat',
      { quarantine: flags.includes('--quarantine') }
    );
    io.stderr(describeConversion(dir, report));
    if (report.liveHolders.length > 0) return 3;
    return report.completed ? 0 : 1;
  } catch (error) {
    if (error instanceof DataDirLayoutError) {
      io.stderr(error.message);
      return error.code === 'CONVERSION_BUSY' ? 3 : 2;
    }
    throw error;
  }
}
