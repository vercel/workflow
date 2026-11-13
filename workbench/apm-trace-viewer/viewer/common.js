// Shared helpers for the trace viewer. Source-agnostic: works for any normalized
// dataset (Axiom, Datadog, …).

// Visual category for a span. Outbound HTTP origin wins first so we can isolate
// "ours" (Vercel Workflow) from third-party traffic; then AI model calls and the
// workflow runtime; then a few well-known Vercel-platform services. Any other
// service falls through to 'service' and gets a stable hashed color, so the viewer
// needs zero per-app configuration.
export function categoryOf(span) {
  if (span.httpOrigin === 'workflow') return 'workflow-http';
  if (span.httpOrigin === 'third-party') return 'other-http';
  if (span.scope === 'ai') return 'ai';
  if (span.scope === 'workflow') return 'workflow';
  if (span.scope === '@vercel/otel/fetch') return 'fetch';
  switch (span.service) {
    case 'vercel.edge-network':
      return 'edge';
    case 'vercel.serverless-runtime':
      return 'serverless';
    case 'next.js':
      return 'next';
    default:
      if (span.scope === 'next.js') return 'next';
      return 'service';
  }
}

// Categories considered "ours" (Vercel Workflow), for the isolate toggle.
export const OURS = new Set(['workflow-http', 'workflow', 'ai']);

// Fixed colors for known categories; everything else is hashed from the service name.
const KNOWN_COLORS = {
  'workflow-http': '#22d3ee',
  workflow: '#3b82f6',
  ai: '#ec4899',
  'other-http': '#4b5563',
  edge: '#8b5cf6',
  serverless: '#10b981',
  next: '#a855f7',
  fetch: '#5a5a5a',
};

export const CAT_LABEL = {
  'workflow-http': 'workflow HTTP (ours)',
  workflow: 'workflow SDK',
  ai: 'ai (model call)',
  'other-http': '3rd-party HTTP',
  edge: 'edge-network',
  serverless: 'serverless-runtime',
  next: 'next.js',
  fetch: 'fetch (no host)',
  service: 'service',
};

// Stable HSL color for an arbitrary service/scope name.
export function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 48% 56%)`;
}

export function colorOf(span) {
  const cat = categoryOf(span);
  if (cat !== 'service') return KNOWN_COLORS[cat] ?? '#64748b';
  return hashColor(span.service || span.scope || 'other');
}

// A small palette for timeline markers (TTFT, first chunk, …), assigned by order.
export const MARKER_COLORS = ['#ec4899', '#10b981', '#f5a623', '#8b5cf6'];

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Format a metric value, honoring unit:'ms' and ';'-separated multi-values.
export function fmtMetricValue(m) {
  const v = m.value;
  if (m.unit === 'ms') {
    if (typeof v === 'number') return fmtMs(v);
    if (typeof v === 'string' && v.includes(';'))
      return v
        .split(';')
        .map((x) => fmtMs(Number(x)))
        .join(' / ');
  }
  return String(v);
}

export function fmtTok(n) {
  if (n == null) return null;
  n = Number(n);
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
