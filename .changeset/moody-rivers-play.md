---
---

Tighten cleanup in `dev.test.ts` `should include steps discovered from workflow imports` so the deferred builder drops the discovered step from the manifest before the next test file runs. Avoids a Windows-only race where the generated step route retains an import to a deleted source file and breaks every subsequent step request.
