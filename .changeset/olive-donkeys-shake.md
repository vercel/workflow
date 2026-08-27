---
'@workflow/builders': patch
---

Resolve TypeScript NodeNext `./x.js` specifiers that name `./x.ts` on disk, and let integrations supply a last-resort `hostResolver` for module ids only the host bundler can provide.
