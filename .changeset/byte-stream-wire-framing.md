---
"@workflow/core": minor
"workflow": minor
---

Add opt-in wire-level framing for byte streams (`type: 'bytes'`) so consumers can identify chunk boundaries — a prerequisite for transparent auto-reconnect. The framing decision is gated on a new `framedByteStreams` capability and recorded per-stream in the serialized ref (`framing: 'framed-v1'`); legacy raw streams continue to work unchanged.
