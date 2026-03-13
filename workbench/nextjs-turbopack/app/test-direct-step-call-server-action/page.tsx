import { ServerActionReproForm } from './form';

/**
 * Manual repro page for a production-only bug where a Next server action
 * directly imports a step whose body depends on imported helpers.
 */
export default function TestDirectStepCallServerActionPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">
          Direct Step Call Server Action Repro
        </h1>
        <p className="text-sm text-neutral-600">
          This page calls a <code>&quot;use step&quot;</code> function from a
          Next server action. The step depends on imported helpers, which used
          to break in production when client-mode pruning removed those imports.
        </p>
      </div>

      <ServerActionReproForm />
    </main>
  );
}
