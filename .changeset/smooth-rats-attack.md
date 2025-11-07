---
"@workflow/core": patch
"@workflow/world-local": patch
---

Add automatic port detection and baseUrl configuration support

- Automatically detect application port using pid-port (no manual configuration needed)
- Support HTTPS and custom hostnames via baseUrl override
- Add WORKFLOW_EMBEDDED_BASE_URL environment variable
- Refactor createEmbeddedWorld API to accept Partial<Config> for better flexibility
- Implement priority-based URL resolution: explicit baseUrl → config port → auto-detected port → PORT env var → 3000 fallback
