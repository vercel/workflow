export const semaphoreUsageSource = `import { withLock, withPermit } from "@/app/workflows/semaphore-workflow";

// Inside any workflow function:
export async function syncAllAccounts(accountIds: string[]) {
  "use workflow";

  // At most 3 concurrent CRM syncs across EVERY run of EVERY workflow.
  const results = await Promise.all(
    accountIds.map((id) =>
      withPermit("crm-sync", 3, () => syncAccount(id)),
    ),
  );

  return { synced: results.length };
}

export async function migrateTenant(tenantId: string) {
  "use workflow";

  // Mutex: only one migration may touch a tenant at a time, cluster-wide.
  return withLock(\`tenant-migration:\${tenantId}\`, () =>
    runMigration(tenantId),
  );
}

async function syncAccount(id: string) {
  "use step";
  // ... call the rate-limited third-party API
  return id;
}

async function runMigration(tenantId: string) {
  "use step";
  // ... the migration body
  return { tenantId, done: true };
}
`;
