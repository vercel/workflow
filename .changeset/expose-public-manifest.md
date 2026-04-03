---
"@workflow/nitro": patch
---

Fix Nitro prod builds: use a physical handler file with inlined manifest content instead of a virtual module with `readFileSync` that referenced an absolute build-machine path
