/**
 * Tiny inline `chalk` replacement.
 *
 * `@workflow/errors/ansi` is reachable from the workflow-VM bundle (via
 * `@workflow/core/workflow` → `context-errors` → `context-violation-error`
 * → here), and the workflow VM has no `require()`. The real `chalk` package
 * pulls in `supports-color`, which calls `require('os')` at module load —
 * so importing `chalk` here crashes every workflow with
 * `ReferenceError: require is not defined`.
 *
 * This module exposes the subset of chalk's call surface that `ansi.ts`
 * uses (`bold`, `dim`, `italic`, `red`, `blue`, `cyan`, `yellow`,
 * `magenta`). Color detection mirrors chalk's defaults at a coarse level:
 * `FORCE_COLOR` forces on, `NO_COLOR` forces off, otherwise we emit ANSI
 * only on a TTY stdout. In the workflow VM `process` is absent so this
 * evaluates to "no color" and the helpers become identity functions —
 * which is what the runtime wants anyway, since the host catches and
 * re-renders the error.
 *
 * Exported from its own module so tests can replace it with `vi.mock` to
 * render styles as readable HTML-like tags in snapshots without dragging
 * `chalk` (and its transitive `supports-color` / `require('os')` chain)
 * back into the workflow VM bundle.
 */

const colorEnabled = (() => {
  const p = (globalThis as { process?: NodeJS.Process }).process;
  if (!p?.env) return false;
  if (p.env.FORCE_COLOR && p.env.FORCE_COLOR !== '0') return true;
  if (p.env.NO_COLOR) return false;
  return Boolean(p.stdout?.isTTY);
})();

const sgr =
  (open: number, close: number) =>
  (s: string): string =>
    colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export interface InternalChalk {
  bold: (s: string) => string;
  dim: (s: string) => string;
  italic: (s: string) => string;
  red: (s: string) => string;
  blue: (s: string) => string;
  cyan: (s: string) => string;
  yellow: (s: string) => string;
  magenta: (s: string) => string;
}

const chalk: InternalChalk = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  red: sgr(31, 39),
  blue: sgr(34, 39),
  cyan: sgr(36, 39),
  yellow: sgr(33, 39),
  magenta: sgr(35, 39),
};

export default chalk;
