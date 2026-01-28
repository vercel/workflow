/**
 * hash - Manage the hash table of remembered command locations
 *
 * hash [-lr] [-p pathname] [-dt] [name ...]
 *
 * Hash maintains a hash table of recently executed commands for faster lookup.
 *
 * Options:
 *   (no args)  Display the hash table
 *   name       Add name to the hash table (look up in PATH)
 *   -r         Clear the hash table
 *   -d name    Remove name from the hash table
 *   -l         Display in a format that can be reused as input
 *   -p path    Use path as the full pathname for name (hash -p /path name)
 *   -t name    Print the remembered location of name
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleHash(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
