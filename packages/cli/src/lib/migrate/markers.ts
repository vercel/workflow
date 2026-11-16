/**
 * Markers the codemods leave in generated code for the project passes in
 * `project.ts`, and helpers every codemod shares.
 */

/** Tag on every comment that marks a change needing a decision. */
export const TODO_TAG = 'TODO(workflow-migrate)';

/** Wrap a type annotation that a later pass validates against the checker. */
export const TYPE_START = '/*@wf:t*/';
export const TYPE_END = '/*@wf:/t*/';
/** Placeholder after a generated parameter whose type a later pass infers. */
export const INFER_MARK = '/*@wf:infer*/';
/**
 * Placeholder after a rest parameter (`...ns`) whose type a later pass infers
 * as a tuple of the remaining call arguments.
 */
export const REST_INFER_MARK = '/*@wf:infer-rest*/';

/** `{ a: string; }` -> `{ a: string }`, as formatters write object types. */
export function tidyType(printed: string): string {
  return printed.replace(/; \}/g, ' }');
}

export function isTypeScriptFile(fileName: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(fileName) && !fileName.endsWith('.d.ts');
}
