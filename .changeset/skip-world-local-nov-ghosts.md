---
'@workflow/world-local': patch
---

Skip past abandoned `5.0.0-beta.8/9/10` npm slots (left over from the November 2025 5.x attempt) so the next Changesets publish lands on a fresh, unoccupied beta.N. The bumped local version is `5.0.0-beta.10`; the next Version Packages PR will compute `5.0.0-beta.11`, which is free. No functional code changes.
