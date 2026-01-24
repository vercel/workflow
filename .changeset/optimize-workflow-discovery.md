---
"@workflow/builders": patch
---

Optimize workflow directive discovery by applying SWC transforms only to files that contain workflow/step directives. Uses regex to quickly filter files, then applies SWC only where needed (<1% of files typically). This maintains correct transformation behavior while reducing overhead for large codebases.
