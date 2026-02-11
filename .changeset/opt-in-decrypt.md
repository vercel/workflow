---
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/web": patch
---

Make decryption an explicit opt-in for o11y tooling

Encrypted values in workflow data are now shown as "🔒 Encrypted" by default in the CLI and web o11y tools. Decryption must be explicitly requested since it triggers audit-logged key retrieval from the Vercel API.

- CLI: Pass `--decrypt` flag to `workflow inspect` commands to decrypt values
- Web: Encrypted values are shown with a placeholder (decrypt-on-demand coming in a follow-up)
- `hydrateResourceIO` now accepts `null` as the `EncryptorResolver` to skip decryption
