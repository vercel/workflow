---
"@workflow/core": patch
---

Fix custom Error subclass serialization precedence: move Instance reducer before Error reducer so that Error subclasses with WORKFLOW_SERIALIZE are serialized using custom class serialization instead of the generic Error serialization
