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

1. **Extraction**: Scans MDX/MD files for fenced code blocks (```typescript, ```ts)
2. **Import inference**: Automatically adds imports for known workflow symbols
3. **Type checking**: Runs TypeScript compiler on each sample

## Adding new symbols

To add import inference for new symbols, edit `src/import-inference.ts`:

<!-- @skip-typecheck: incomplete code sample -->
```typescript
const SYMBOL_IMPORTS: Record<string, ImportMapping> = {
  // Add your symbol here
  MyNewSymbol: { module: 'workflow' },
  MyType: { module: 'workflow', isType: true }, // For type-only imports
};
```

## Adding placeholder types

For user-defined types/functions commonly used in docs, edit `src/docs-globals.d.ts`.
