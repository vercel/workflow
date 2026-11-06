---
'@workflow/utils': patch
---

Detect dev servers that listen only on IPv6 (such as Vite on `localhost`, which binds `::1`) on Windows, where `netstat -p tcp` lists IPv4 sockets only.
