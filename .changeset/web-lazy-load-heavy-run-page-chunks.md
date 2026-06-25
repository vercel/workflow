---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Speed up run-detail page loads by lazy-loading two heavy dependency trees that the trace view never needs: the Streamdown markdown renderer (which pulls in Mermaid + Shiki, ~1.7 MB) and the flow-graph viewer (~600 KB, behind the currently-hidden Graph tab). Both are now code-split and fetched on demand, cutting the JavaScript shipped on initial run load by ~36% (~1.2 MB).
