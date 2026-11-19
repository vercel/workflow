# Validation

## When to Use

Use whenever a task changes code in `packages/web` or `packages/web-shared`: new features, bug fixes, refactors, and style or layout changes. Pick the checks that fit the change before calling the work done.

## Required Patterns

### Unit Tests for Logic

Add or extend unit tests when the change contains logic: a function or component whose output depends on its inputs. Each test calls the function or renders the component with specific inputs and asserts on the output.

- Cover the happy path and the edge cases that could break it: empty and missing values, boundaries, invalid input, and combinations that need special handling.
- Test through public interfaces: return values, rendered output, and user interactions. Don't assert on private structure or styling classes.
- Extend an existing test file before creating a new one.

Run the tests for each package with:

```bash
pnpm --filter @workflow/web test
pnpm --filter @workflow/web-shared test
```

`packages/web` runs Vitest in jsdom with the `~` alias pointing at `app/`.

### No Tests for Trivial Changes

Don't add tests that can only fail if the code was edited on purpose or if TypeScript itself is broken. Those test the language, not our code. Remove existing tests like these when you find them.

- Don't assert that a constant, config object, or array equals the value you just wrote.
- Don't assert that a value has the type TypeScript already guarantees.
- Don't add a test only to show that a one-line change runs.

### Static Checks

Run `pnpm lint` and `pnpm typecheck` from the repository root.

### Rendered Checks

When a change affects what the UI looks like (styles, layout, a new design, loading states, or responsive behavior), render it and check it in both themes. Start the observability UI against a project with workflow runs, for example `npx workflow web` in a workbench app after running some workflows.

Check every state the change can reach, not only the default one: loading, empty, populated, error, and long content.

Changes to `packages/web-shared` also render inside the Vercel dashboard. When the change affects layout or styling there, check it in the dashboard too before release.
