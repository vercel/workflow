# Chain

Chains efficiently link values across steps, preserving shared prefixes as they
grow or branch.

`Chain<T>` is an experimental immutable append-only value for step-owned
ordered data. New additions and declarative reconstruction recipes are committed
inside ordinary step outputs; no separate blob store is used.

```ts
import { Chain } from 'workflow';

async function turn(history?: Chain<Message>) {
  'use step';
  const messages = history ? await history.toArray() : [];
  const next = await generate(messages);
  return (history ?? Chain.from([])).append(next);
}
```

`append()` returns a new value, so appending twice from one input creates two
independent descendants. `take(n)` creates a fixed prefix. `get()` and
`toArray()` return detached ordinary values; appending an extracted value stores
it as new data. Compaction creates a new root with
`Chain.from(compactedMessages)` inside a step.

Supported inserted data is acyclic JSON plain data with finite numbers, dense
arrays, and enumerable string-keyed data properties. Proxies, accessors, sparse
arrays, symbols, non-plain objects, and non-finite numbers fail explicitly.

## Execution model

A Chain reference identifies an accepted producing step output, a result-local
slot, and a prefix length. Resolution reads versioned inert recipes from those
committed outputs and never executes workflow code, completed steps, or unrelated
application deserializers. Recipes and ordinary output are authenticated and
compressed together by the existing payload pipeline.

Workflow code can carry a committed Chain and call `take()`. Creating,
appending, and reading content are step-only. Initial data must therefore be
created by a seed step. References are same-run; cross-run or cross-deployment
handoff must materialize and reseed.

## Limitations

- Node workflow execution only; QuickJS fails explicitly.
- Standalone cold resolution may fetch complete producing outputs serially.
  Normal inline replay reuses authoritative invocation-local event result bytes.
- Returning overlapping intermediate and final local drafts duplicates their new
  additions in separate recipes. Existing committed base payloads remain refs.
- Full observability UI materialization is not implemented. Ordinary sibling
  output fields hydrate normally; Chain descriptors remain inspectable without
  reading content.
- Direct low-level codec consumers that bypass the standard hydration helpers do
  not understand the inner recipe format.
- The API, naming, wire format, resource limits, retention policy, and handoff
  semantics remain experimental.
