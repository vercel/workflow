---
---

Gate the e2e suite for cross-language conformance — tests whose subject is the JS implementation are marked JS-only, and an app declares via `e2e-conformance.json` which `99_e2e` fixtures it implements plus any individual tests its runtime cannot yet support — and add `workbench/python` as the first non-JavaScript target. No-op for the existing workbench apps, which ship no declaration.
