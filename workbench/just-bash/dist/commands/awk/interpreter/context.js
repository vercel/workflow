/**
 * AWK Runtime Context
 *
 * Holds all state for AWK program execution.
 */
const DEFAULT_MAX_ITERATIONS = 10000;
// Keep low to prevent JS stack overflow (each AWK call uses ~10-20 JS stack frames)
const DEFAULT_MAX_RECURSION_DEPTH = 100;
export function createRuntimeContext(options = {}) {
    const { fieldSep = /\s+/, maxIterations = DEFAULT_MAX_ITERATIONS, maxRecursionDepth = DEFAULT_MAX_RECURSION_DEPTH, fs, cwd, exec, } = options;
    return {
        FS: " ",
        OFS: " ",
        ORS: "\n",
        OFMT: "%.6g",
        NR: 0,
        NF: 0,
        FNR: 0,
        FILENAME: "",
        RSTART: 0,
        RLENGTH: -1,
        SUBSEP: "\x1c",
        fields: [],
        line: "",
        vars: {},
        arrays: {},
        arrayAliases: new Map(),
        ARGC: 0,
        ARGV: {},
        ENVIRON: {},
        functions: new Map(),
        fieldSep,
        maxIterations,
        maxRecursionDepth,
        currentRecursionDepth: 0,
        exitCode: 0,
        shouldExit: false,
        shouldNext: false,
        shouldNextFile: false,
        loopBreak: false,
        loopContinue: false,
        hasReturn: false,
        inEndBlock: false,
        output: "",
        openedFiles: new Set(),
        fs,
        cwd,
        exec,
    };
}
