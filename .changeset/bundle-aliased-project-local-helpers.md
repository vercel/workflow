---
"@workflow/builders": patch
---

Fix `Package subpath ... is not defined by "exports"` runtime errors when step files reach project-local helpers via tsconfig `paths` / esbuild aliases / self-referencing package names.

Such helpers are now bundled inline rather than externalized as relative paths. Externalization was unsafe because the helper's source on disk could contain further alias imports, and Node's ESM loader at runtime doesn't know about build-time path mappings — leading to errors like `Package subpath './lib/foo' is not defined by "exports"` (or `ERR_MODULE_NOT_FOUND`) once the helper was loaded.
