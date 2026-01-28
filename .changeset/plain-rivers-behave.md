---
"@workflow/world-postgres": patch
"@workflow/world-testing": patch
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/web-shared": patch
"@workflow/world": patch
"@workflow/core": patch
"@workflow/cli": patch
---

**BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.
