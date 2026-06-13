// Shared real-world-style workloads for the compression benchmarks.
//
// Used by both `benchmark-compression-size.mjs` (storage bytes) and
// `benchmark-compression-cpu.mjs` (serialize/deserialize CPU cost) so the
// two benchmarks measure the exact same payloads and stay comparable.
//
// All generators are deterministic (seeded PRNG) so benchmark runs are
// reproducible and diffable across commits / algorithms.

// Deterministic PRNG (xorshift32).
export function makeRng(seed = 0x9e3779b9) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

const VOCAB =
  `the a an of to in on for with by from runtime workflow step event log replay deterministic durable execution serverless function queue retry backoff failure deployment cold start state checkpoint persist suspend resume orchestrator sandbox compute storage payload serialization compression encryption stream hook webhook token correlation idempotent schedule timer sleep await promise race parallel batch fetch request response error fatal retryable budget timeout attempt delivery message billing invoice customer subscription usage metric latency throughput region edge node cluster shard partition index query transaction commit rollback migration schema column record entity snapshot version`.split(
    /\s+/
  );

/** Generate plausible, non-repetitive English-ish text deterministically. */
export function makeText(rng, words) {
  const out = [];
  let sentenceLen = 0;
  for (let i = 0; i < words; i++) {
    let word = VOCAB[Math.floor(rng() * VOCAB.length)];
    if (sentenceLen === 0) word = word[0].toUpperCase() + word.slice(1);
    out.push(word);
    sentenceLen++;
    if (sentenceLen > 6 && rng() < 0.18) {
      out[out.length - 1] += '.';
      sentenceLen = 0;
    } else if (rng() < 0.08) {
      out[out.length - 1] += ',';
    }
  }
  return out.join(' ');
}

/** AI agent chat history — the canonical DurableAgent workload. */
export function aiChatHistory(messages = 60) {
  const rng = makeRng(0xc0ffee);
  const out = [];
  for (let i = 0; i < messages; i++) {
    if (i % 2 === 0) {
      out.push({
        role: 'user',
        content: makeText(rng, 30 + Math.floor(rng() * 40)),
      });
    } else {
      out.push({
        role: 'assistant',
        content: makeText(rng, 150 + Math.floor(rng() * 250)),
        toolCalls:
          i % 6 === 5
            ? [
                {
                  toolCallId: `call_${i}_${Math.floor(rng() * 1e12).toString(36)}`,
                  toolName: 'search_documentation',
                  args: {
                    query: makeText(rng, 6),
                    limit: 5,
                  },
                },
              ]
            : undefined,
      });
    }
  }
  return { messages: out, model: 'claude-fable-5', temperature: 0.7 };
}

/** Paginated REST API response — list endpoints fetched in steps. */
export function apiUserList(count = 250) {
  return {
    users: Array.from({ length: count }, (_, i) => ({
      id: `usr_${i.toString(16).padStart(8, '0')}`,
      object: 'user',
      email: `person.${i}@bigcorp-enterprises.example.com`,
      name: `Person Q. Example the ${i}th`,
      role: i % 7 === 0 ? 'admin' : i % 3 === 0 ? 'editor' : 'viewer',
      teamIds: [`team_${i % 12}`, `team_${i % 5}`],
      createdAt: new Date(Date.UTC(2024, i % 12, (i % 27) + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, i % 12, (i % 27) + 1)).toISOString(),
      settings: {
        notifications: { email: true, slack: i % 2 === 0, mobile: false },
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
      },
      metadata: { source: 'scim-sync', importBatch: `batch_${i % 40}` },
    })),
    hasMore: true,
    nextCursor: 'usr_000000fa',
  };
}

/** E-commerce order — checkout/fulfillment workflow state. */
export function ecommerceOrder(lineItems = 30) {
  return {
    orderId: 'ord_2WqK9mPx7nL4vR8t',
    status: 'processing',
    customer: {
      id: 'cus_9XkL2mNp5qR7sT1v',
      email: 'jane.shopper@example.com',
      shippingAddress: {
        line1: '2001 Workflow Way',
        line2: 'Suite 400',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94107',
        country: 'US',
      },
    },
    items: Array.from({ length: lineItems }, (_, i) => ({
      sku: `SKU-${1000 + i}`,
      name: `Durable Widget ${i} — Professional Edition`,
      quantity: (i % 3) + 1,
      unitPriceCents: 1999 + i * 250,
      taxCents: Math.round((1999 + i * 250) * 0.0875),
      fulfillmentStatus: i % 4 === 0 ? 'backordered' : 'allocated',
      warehouse: `wh-${i % 6}`,
    })),
    payments: [
      {
        id: 'pay_4YmN8pQr2sT6uV0w',
        provider: 'stripe',
        amountCents: 84321,
        status: 'captured',
        capturedAt: '2026-06-11T18:23:11.000Z',
      },
    ],
    timeline: Array.from({ length: 12 }, (_, i) => ({
      at: `2026-06-11T18:${String(i * 4).padStart(2, '0')}:00.000Z`,
      event: ['created', 'paid', 'allocated', 'picked'][i % 4],
      actor: 'system',
    })),
  };
}

/** Scraped/generated document text — summarization pipelines. */
export function markdownDocument(paragraphs = 40) {
  const rng = makeRng(0xd0c5);
  const parts = [];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(makeText(rng, 60 + Math.floor(rng() * 60)));
  }
  return {
    url: 'https://example.com/blog/durable-execution-deep-dive',
    title: 'Durable Execution: A Deep Dive',
    fetchedAt: '2026-06-12T09:00:00.000Z',
    content: parts.join('\n\n'),
  };
}

/** Time-series metrics — monitoring/aggregation workloads. */
export function timeSeries(points = 2000) {
  const base = 1749700000000;
  return {
    metric: 'http.server.request.duration',
    unit: 'ms',
    points: Array.from({ length: points }, (_, i) => [
      base + i * 60_000,
      Math.round(40 + 30 * Math.sin(i / 50) + (i % 17)),
    ]),
  };
}

/** Tiny payload — stays below the compression threshold by design. */
export function tinyPayload() {
  return { ok: true, id: 'wrun_01J5XYZ', count: 3 };
}

/** Incompressible binary — e.g. an image/zip passed through a step. */
export function binaryPayload(bytes = 256 * 1024) {
  // Deterministic pseudo-random bytes (xorshift) so runs are reproducible.
  let state = 0x12345678;
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 0xff;
  }
  return data;
}

/**
 * The standard workload set, shared by both benchmarks. Each entry is
 * `[label, value]`. Order matters only for display.
 */
export const WORKLOADS = [
  ['AI chat history (60 messages)', aiChatHistory()],
  ['API response (250 users)', apiUserList()],
  ['E-commerce order (30 items)', ecommerceOrder()],
  ['Scraped document (~27 KB text)', markdownDocument()],
  ['Time series (2000 points)', timeSeries()],
  ['Random binary (256 KB)', binaryPayload()],
  ['Tiny payload (<1 KB)', tinyPayload()],
];
