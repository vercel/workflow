// `arguments` inside a nested `function`-form step body must NOT be treated
// as a closure variable — it's a per-function intrinsic binding that
// reflects the positional args the runtime passes via `stepFn.apply(thisVal,
// args)`. Without the `is_global_identifier("arguments")` exclusion, the
// hoisted body would gain `const { arguments } = ...` (a syntax error in
// strict mode) and the original `arguments[0]` access would silently break.
export async function outer() {
  'use workflow';

  async function step() {
    'use step';
    return arguments[0];
  }

  return step('hello');
}
