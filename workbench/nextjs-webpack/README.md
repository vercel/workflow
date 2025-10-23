# Clone of ../nextjs-turbopack

This directory is mostly a clone of the turbopack workbench with nearly everything symlinked to the directory.

The `package.json` is notably different - it does NOT use `--turbo` to force webpack bundling.

## Symlinks

Most files/directories are symlinked to `../nextjs-turbopack`:
- `app/` - All files inside are symlinked (not the directory itself)
- `workflows/` - Symlinked directory
- `util/` - Symlinked directory
- `public/` - Symlinked directory
- `instrumentation.ts` - Symlinked file
- `postcss.config.mjs` - Symlinked file
- `tsconfig.json` - Symlinked file
- `turbo.json` - Symlinked file

A few specific files are NOT symlinked:
- `app/favicon.ico` - Real file (symlink doesn't work with Next.js)
- `app/.well-known/` - Generated directory by workflow
- `.gitignore` - Real file
- `next.config.ts` - Different configuration (webpack-specific)
- `package.json` - Different configuration (no `--turbo` flag)

## CI Symlink Resolution

Next.js dev mode doesn't work well with symlinks. In CI, the `resolve-symlinks.sh` script automatically runs before starting the dev server to replace all symlinks with actual file copies. The script:
- Only runs when `CI` environment variable is set
- Resolves all symlinks in the directory (excluding gitignored files like `node_modules`)
- Preserves the directory structure while replacing symlinks with real files