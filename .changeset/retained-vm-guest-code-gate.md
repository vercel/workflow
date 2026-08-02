---
'@workflow/core': minor
'workflow': minor
---

Retained-VM boundaries now accept plain data and standard built-ins (`Map`, `Set`, `Date`, typed arrays, `URL`, `Headers`, …) as step inputs. The suspension handler gates retention on the hardened serializer's guest-code report: boundaries whose serialization executed workflow code or observable engine state (getters, proxies, custom serializers, `Error` stack materialization) fall back to ordinary replay.
