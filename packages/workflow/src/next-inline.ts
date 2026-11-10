/**
 * **Experimental.** `import 'workflow/next/inline'` in a Next.js route loads
 * the app's flow entry (its workflows, steps and orchestrator handler) into
 * that route, so `start(..., { experimental_inline: true })` and
 * `resumeHook(..., { experimental_inline: true })` there can run the run's
 * first orchestrator delivery in the same request, with no queue hop.
 *
 * `withWorkflow()` aliases this specifier to the generated flow route. This
 * module is what it resolves to anywhere else: it loads nothing, so `start()`
 * keeps queueing the run as usual.
 *
 * @experimental
 */
export {};
