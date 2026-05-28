---
"@workflow/errors": patch
"@workflow/core": patch
---

Classify SDK-level encryption failures as `RUNTIME_ERROR` instead of `USER_ERROR`. Introduces a new `RuntimeDecryptionError` (subclass of `WorkflowRuntimeError`) that the AES-GCM encryption module throws when the Web Crypto API fails — most notably the native `OperationError` from `AESCipherJob.onDone` on GCM auth-tag mismatch. The wrapped error carries the original DOMException as `cause` plus diagnostic context (byte length, printable header prefix).
