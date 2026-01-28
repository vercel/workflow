/**
 * break - Exit from loops builtin
 */
import { BreakError, ExitError, SubshellExitError } from "../errors.js";
import { OK } from "../helpers/result.js";
export function handleBreak(ctx, args) {
    // Check if we're in a loop
    if (ctx.state.loopDepth === 0) {
        // If we're in a subshell spawned from a loop context, exit the subshell
        if (ctx.state.parentHasLoopContext) {
            throw new SubshellExitError();
        }
        // Otherwise, break silently does nothing (returns 0)
        return OK;
    }
    // bash: too many arguments is an error (exit code 1)
    if (args.length > 1) {
        throw new ExitError(1, "", "bash: break: too many arguments\n");
    }
    let levels = 1;
    if (args.length > 0) {
        const n = Number.parseInt(args[0], 10);
        if (Number.isNaN(n) || n < 1) {
            // Invalid argument causes a fatal error in bash (exit code 128)
            throw new ExitError(128, "", `bash: break: ${args[0]}: numeric argument required\n`);
        }
        levels = n;
    }
    throw new BreakError(levels);
}
