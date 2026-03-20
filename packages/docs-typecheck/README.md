# @workflow/docs-typecheck

Type-checks TypeScript code samples in documentation files to ensure they are valid.

## Usage

### Run all documentation tests

From the repository root:

```bash
pnpm test:docs
```

Or from this package directory:

```bash
pnpm test:docs
```

### Run tests for specific files

Use the `DOCS_FILE` environment variable to filter which files to test:

```bash
# Test a specific file (partial path match)
DOCS_FILE="ai/index.mdx" pnpm test:docs

# Test multiple files (comma-separated)
DOCS_FILE="hooks.mdx,streaming.mdx" pnpm test:docs

# Test all files in a directory
DOCS_FILE="foundations/" pnpm test:docs
```

### Skip type checking for specific code blocks

Add a comment before the code block (invisible in rendered docs):

**For MDX files** (use JSX comment syntax):

```markdown
{/* @skip-typecheck: reason */}
```typescript
// This code will not be type-checked
```
```

**For Markdown files** (use HTML comment syntax):

```markdown
<!-- @skip-typecheck: reason -->
```typescript
// This code will not be type-checked
```
```

### Expect specific errors

For code samples that intentionally show errors:

```markdown
<!-- @expect-error:2304,2307 -->
```typescript
// This code expects TS2304 and TS2307 errors
```
```

## How it works

1. **Extraction**: Scans MDX/MD files for fenced `ts`, `typescript`, `js`, and `javascript` code blocks.
2. **Filtering**: Applies `@skip-typecheck` / `@expect-error` markers and automatically skips incomplete or error-demo snippets.
3. **Batch type checking**: Runs the remaining **TypeScript** samples in a single TypeScript program using explicit workspace `paths` mappings from `src/type-checker.ts` and shared placeholder declarations from `src/docs-globals.d.ts`.

## What gets checked

The docs test suite includes:
- `docs/content/docs/**/*.mdx`
- `packages/*/README.md`

Within those files, fenced `ts` / `typescript` samples are type-checked exactly as written. The tool does **not** auto-insert or infer imports.

Fenced `js` / `javascript` samples are currently extracted by the parser, but they are not part of the verification pass yet.

## Extending module resolution

If a docs example needs a new package or subpath to resolve during type checking, add it to `compilerOptions.paths` in `src/type-checker.ts`.

<!-- @skip-typecheck: incomplete code sample -->
```typescript
paths: {
  // existing mappings...
  '@workflow/new-package': [path.join(repoRoot, 'packages/new-package/dist/index')],
}
```

## Adding shared placeholder types

For user-defined globals or placeholder declarations used across docs examples, update `src/docs-globals.d.ts`.
