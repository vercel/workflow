---
'@workflow/builders': patch
---

Skip rewriting generated files when the content is unchanged, so a rebuild whose output is byte-identical no longer bumps the mtime and inode of a file inside the watched app directory. Removes one redundant webpack compilation round per no-op rebuild in Next dev.
