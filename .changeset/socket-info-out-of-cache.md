---
"@workflow/next": patch
---

Move `workflow-socket.json` out of `.next/cache/` so it isn't preserved across Vercel/Turborepo builds, and clean up stale copies at builder boot. Resolves `ECONNREFUSED 127.0.0.1:<port>` failures from the webpack loader when a prior build's socket-info file was restored from build cache. The loader now also annotates connection errors with the port, credentials source, and the file being processed.
