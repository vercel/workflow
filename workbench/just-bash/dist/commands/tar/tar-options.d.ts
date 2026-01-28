/**
 * Option parsing for tar command
 */
import type { ExecResult } from "../../types.js";
export interface TarOptions {
    create: boolean;
    append: boolean;
    update: boolean;
    extract: boolean;
    list: boolean;
    file: string;
    autoCompress: boolean;
    gzip: boolean;
    bzip2: boolean;
    xz: boolean;
    zstd: boolean;
    verbose: boolean;
    toStdout: boolean;
    keepOldFiles: boolean;
    touch: boolean;
    directory: string;
    preserve: boolean;
    strip: number;
    exclude: string[];
    filesFrom: string;
    excludeFrom: string;
    wildcards: boolean;
}
export declare function parseOptions(args: string[]): {
    ok: true;
    options: TarOptions;
    files: string[];
} | {
    ok: false;
    error: ExecResult;
};
