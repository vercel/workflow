export const rateLimiterUsageSource = `import { withRateLimit } from "@/app/workflows/rate-limiter-workflow";

export async function enrichContacts(contactIds: string[]) {
  "use workflow";

  // Max ~5 requests/second to the enrichment API across the whole cluster,
  // no matter how many runs of any workflow are active.
  const results = await Promise.all(
    contactIds.map((id) =>
      withRateLimit("enrichment-api", 200, () => enrichContact(id)),
    ),
  );

  return { enriched: results.length };
}

async function enrichContact(id: string) {
  "use step";
  const res = await fetch(\`https://api.enrichment.example.com/contacts/\${id}\`);
  return res.json();
}
`;
