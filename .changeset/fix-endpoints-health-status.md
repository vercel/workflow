---
'@workflow/core': patch
'@workflow/web': patch
---

Fix endpoints health status component based on code review feedback

- Fixed base URL determination to handle non-local backends (vercel, postgres)
- Improved config key generation to include all relevant backend-specific fields
- Fixed useEffect dependencies to prevent unnecessary re-checks
- Added cleanup handler for unmounted component to prevent React warnings
- Documented CORS security implications in code comments
