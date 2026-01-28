/**
 * Lightweight Bash class for Workflow context.
 *
 * This is a minimal version of the Bash class that only handles state storage
 * and serialization. It does NOT include command execution capabilities.
 *
 * In workflow context, Bash instances are only passed between steps - actual
 * command execution happens in step context where the full Bash class is used.
 *
 * IMPORTANT: This class must have the same serialization format as the full
 * Bash class so that instances can be serialized in step context and
 * deserialized in workflow context (and vice versa).
 */
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { resolveLimits } from "./limits.js";
/**
 * Lightweight Bash class for workflow context.
 *
 * This class can:
 * - Be serialized and deserialized
 * - Hold filesystem and interpreter state
 * - Be passed between workflow steps
 *
 * This class CANNOT:
 * - Execute bash commands (use the full Bash class in step context)
 * - Access command implementations
 */
export class Bash {
    fs;
    state;
    limits;
    constructor(options = {}) {
        this.fs = options.fs ?? new InMemoryFs();
        this.limits = resolveLimits(options.executionLimits);
        // Initialize minimal state for workflow context
        // This matches the initial state from the full Bash class
        this.state = {
            env: {
                HOME: "/home/user",
                PATH: "/usr/bin:/bin",
                IFS: " \t\n",
                PWD: "/home/user",
                OLDPWD: "/home/user",
                OPTIND: "1",
            },
            cwd: "/home/user",
            previousDir: "/home/user",
            lastExitCode: 0,
            lastArg: "",
            currentLine: 1,
            options: {
                errexit: false,
                pipefail: false,
                nounset: false,
                xtrace: false,
                verbose: false,
                posix: false,
                allexport: false,
                noclobber: false,
                noglob: false,
                noexec: false,
                vi: false,
                emacs: false,
            },
            shoptOptions: {
                extglob: false,
                dotglob: false,
                nullglob: false,
                failglob: false,
                globstar: false,
                globskipdots: true,
                nocaseglob: false,
                nocasematch: false,
                expand_aliases: false,
                lastpipe: false,
                xpg_echo: false,
            },
            functions: new Map(),
            localScopes: [],
            callDepth: 0,
            sourceDepth: 0,
            commandCount: 0,
            startTime: Date.now(),
            lastBackgroundPid: 0,
            bashPid: typeof process !== "undefined" ? process.pid : 1,
            nextVirtualPid: (typeof process !== "undefined" ? process.pid : 1) + 1,
            exportedVars: new Set(["HOME", "PATH", "PWD", "OLDPWD"]),
            readonlyVars: new Set(["SHELLOPTS", "BASHOPTS"]),
            hashTable: new Map(),
            inCondition: false,
            loopDepth: 0,
        };
    }
    // ===========================================================================
    // Workflow Serde Support
    // ===========================================================================
    /**
     * Serialize Bash instance for Workflow DevKit.
     * Serializes filesystem and interpreter state.
     */
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            fs: instance.fs,
            state: instance.state,
            limits: instance.limits,
        };
    }
    /**
     * Deserialize Bash instance for Workflow DevKit.
     */
    static [WORKFLOW_DESERIALIZE](serialized) {
        const bash = new Bash({ fs: serialized.fs });
        bash.state = serialized.state;
        bash.limits = serialized.limits;
        return bash;
    }
    // ===========================================================================
    // Read-only accessors (for workflow context inspection)
    // ===========================================================================
    getCwd() {
        return this.state.cwd;
    }
    getEnv() {
        return { ...this.state.env };
    }
}
