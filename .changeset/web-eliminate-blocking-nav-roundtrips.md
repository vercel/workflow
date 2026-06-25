---
'@workflow/web': patch
---

Fix run/detail pages appearing to hang for seconds on navigation. React Router was making two blocking server round-trips before each client navigation could render — a lazy `/__manifest` route-discovery request and a root-loader `.data` request that needlessly re-fetched the static server config every time. These stall the whole page when the dashboard backend is remote or cold. Ship routes eagerly (`routeDiscovery: 'initial'`) and stop revalidating the root config loader on navigation (`shouldRevalidate`), so navigations render immediately and only the page's own data loads afterward.
