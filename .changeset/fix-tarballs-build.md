---
---

Fix the `tarballs` Vercel project so workspace dependencies are built before packing — without this, every preview tarball ships with an empty `dist/` directory and downstream installs fail to resolve `dist/*` entry points.
