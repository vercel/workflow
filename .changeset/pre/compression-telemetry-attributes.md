---
'@workflow/core': patch
---

Emit OpenTelemetry span attributes for payload compression on the serialize (write) and deserialize (read) paths: `workflow.serialization.{operation,compressed,uncompressed_bytes,stored_bytes,compression_ratio}`. Sizes are measured at the compression boundary (pre-encryption). Telemetry failures never affect serialization.
