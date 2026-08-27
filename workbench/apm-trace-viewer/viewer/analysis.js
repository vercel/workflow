// Trace-shape analysis, shared by the waterfall and flame views. Presentation
// helpers (colors, formatting) live in common.js; this file only reshapes spans.

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

// Read a dotted attribute off a span. Importers emit `attrs` either as a flat map
// with literal dotted keys or as nested objects, so try the flat key first, then walk.
export function spanAttr(s, dotted) {
  let node = s?.attrs;
  if (node == null) return undefined;
  if (dotted in node) return node[dotted];
  for (const part of dotted.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

export const spanEnd = (s) => s.startMs + (s.durMs ?? 0);

// Join two values into one Map key. NUL is the delimiter because a span name or service
// can contain anything printable, and a delimiter that appears in a component would
// collapse two distinct buckets into one.
const compositeKey = (a, b) => `${a}\u0000${b}`;

// ---------------------------------------------------------------------------
// WebSocket event-frame reparenting
// ---------------------------------------------------------------------------
// The SDK's WS events transport synthesizes one client `http POST` span per event
// frame, but a frame carries no W3C traceparent - only the WS handshake does. So the
// server-side write for every frame parents to the long-lived handshake span instead
// of to the frame that caused it. The trace stays connected, but per-frame correlation
// is gone: server work renders as one undifferentiated pile under the connection, and
// you cannot see which client frame paid for which server write.
//
// Recover the pairing from what the data does carry. Client frames are tagged
// `workflow.event.type`, server event spans `workflow.event_type`. Within one trace
// (= one connection) both sides observe the same event sequence in the same order, so
// bucket by (trace, type) and pair in chronological order. A pair is admitted only if
// the server span starts inside the client frame's window, allowing for cross-host
// clock skew; anything failing that check is left untouched rather than guessed at.
const WS_SKEW_MS = 50;

const isWsFrame = (s) =>
  s.kind === 'client' && spanAttr(s, 'workflow.events.transport') === 'ws';
const isServerEvent = (s) =>
  s.kind === 'server' && spanAttr(s, 'workflow.event_type') != null;

/**
 * Compute corrected parents for misparented WS server spans.
 * Pure: returns a plan, mutates nothing.
 * @returns {{map: Map<string,string>, matched: number, unmatched: number, frames: number}}
 */
export function wsReparentPlan(spans) {
  const frames = new Map(); // "trace type" -> client frame spans
  const targets = new Map(); // "trace type" -> server event spans
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  let frameCount = 0;
  for (const s of spans) {
    if (isWsFrame(s)) {
      frameCount++;
      const t = spanAttr(s, 'workflow.event.type');
      if (t != null) push(frames, compositeKey(s.trace, t), s);
    } else if (isServerEvent(s)) {
      push(
        targets,
        compositeKey(s.trace, spanAttr(s, 'workflow.event_type')),
        s
      );
    }
  }
  const byStart = (a, b) => a.startMs - b.startMs;
  for (const arr of frames.values()) arr.sort(byStart);
  for (const arr of targets.values()) arr.sort(byStart);

  const map = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const [key, ts] of targets) {
    const fs = frames.get(key) ?? [];
    const used = new Set();
    let from = 0; // frames are consumed in order; never pair backwards
    for (const t of ts) {
      let hit = -1;
      for (let j = from; j < fs.length; j++) {
        if (used.has(j)) continue;
        const f = fs[j];
        if (
          t.startMs >= f.startMs - WS_SKEW_MS &&
          t.startMs <= spanEnd(f) + WS_SKEW_MS
        ) {
          hit = j;
          break;
        }
      }
      if (hit === -1) {
        unmatched++;
        continue;
      }
      used.add(hit);
      from = hit + 1;
      map.set(t.id, fs[hit].id);
      matched++;
    }
  }
  return { map, matched, unmatched, frames: frameCount };
}

/** Apply a reparent plan, returning new span objects (originals untouched). */
export function applyReparent(spans, map) {
  if (!map?.size) return spans;
  return spans.map((s) =>
    map.has(s.id) ? { ...s, parent: map.get(s.id), wsReparented: true } : s
  );
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/** Build a forest: children by parent id, roots, and a depth per span id. */
export function buildForest(spans) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    const p = s.parent && byId.get(s.parent);
    if (p) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    } else roots.push(s);
  }
  const byStart = (a, b) => a.startMs - b.startMs;
  roots.sort(byStart);
  for (const arr of kids.values()) arr.sort(byStart);

  // Iterative walk: these traces nest deeply enough that recursion is a real risk.
  const depth = new Map();
  const stack = roots.map((r) => [r, 0]);
  const seen = new Set();
  while (stack.length) {
    const [s, d] = stack.pop();
    if (seen.has(s.id)) continue; // a parent cycle would otherwise spin forever
    seen.add(s.id);
    depth.set(s.id, d);
    for (const c of kids.get(s.id) ?? []) stack.push([c, d + 1]);
  }
  // Anything unreachable (only possible via a cycle) still needs a row.
  for (const s of spans) if (!depth.has(s.id)) depth.set(s.id, 0);
  return { byId, kids, roots, depth };
}

// ---------------------------------------------------------------------------
// STSO - step-to-step overhead
// ---------------------------------------------------------------------------
// The SDK emits a nested pair per step: an outer `step.execute <name>` and an inner
// unnamed `step.execute`. The inner one is the user's own step body; the outer one also
// covers the SDK work bracketing it, most importantly the blocking `step_completed`
// POST at its tail (61-495ms on the traces this was built against). STSO is measured
// between inner spans precisely so that POST lands *inside* the gap, where you can see
// it, rather than being hidden inside the previous step's bar.
//
// An outer with no inner child is a replay: the invocation re-created the step span,
// wrote `step_started`, found the step already done and ran no user code. Those are
// dropped - counting them would invent a step boundary where the user's code never ran.

/** The user-code step spans (inner), each labelled from its outer parent. */
export function userStepExecutes(spans) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const isStep = (s) => (s?.name ?? '').startsWith('step.execute');
  const out = [];
  for (const s of spans) {
    if (!isStep(s)) continue;
    const outer = byId.get(s.parent);
    if (!isStep(outer)) continue; // this is an outer span, not user code
    out.push({
      span: s,
      outer,
      name: (outer.name ?? '').replace(/^step\.execute\s*/, '') || '(unnamed)',
      startMs: s.startMs,
      endMs: spanEnd(s),
      trace: s.trace,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Outer step spans that ran no user code - replays, excluded from STSO. */
export function replayStepExecutes(spans) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const isStep = (s) => (s?.name ?? '').startsWith('step.execute');
  const hasInner = new Set();
  for (const s of spans)
    if (isStep(s) && isStep(byId.get(s.parent))) hasInner.add(s.parent);
  return spans.filter(
    (s) => isStep(s) && !isStep(byId.get(s.parent)) && !hasInner.has(s.id)
  );
}

/**
 * Gaps where no user step body was running - the window this view exists to explain.
 *
 * Two things make a naive "next.start - prev.end" wrong. Steps run in parallel
 * (Promise.all), so consecutive-by-start pairs overlap and subtract to a negative
 * "overhead" that means nothing; overlapping steps are merged into one cluster first,
 * because while any step body is running you are not paying step-to-step overhead. And
 * a boundary between traces is a durable suspend/resume, not overhead, so gaps are
 * computed per trace rather than across the whole run.
 *
 * @returns {{gaps: Array, replaySkipped: number, steps: number}}
 */
export function stsoGaps(spans) {
  const steps = userStepExecutes(spans);
  const byTrace = new Map();
  for (const s of steps) {
    if (!byTrace.has(s.trace)) byTrace.set(s.trace, []);
    byTrace.get(s.trace).push(s);
  }
  const gaps = [];
  for (const [trace, arr] of byTrace) {
    const clusters = [];
    for (const s of arr) {
      // arr is sorted by start, so only the open cluster can overlap.
      const last = clusters[clusters.length - 1];
      if (last && s.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, s.endMs);
        last.members.push(s);
      } else {
        clusters.push({ startMs: s.startMs, endMs: s.endMs, members: [s] });
      }
    }
    for (const c of clusters) {
      c.first = c.members[0];
      c.last = c.members.reduce((a, b) => (b.endMs > a.endMs ? b : a));
    }
    for (let i = 1; i < clusters.length; i++) {
      const a = clusters[i - 1];
      const b = clusters[i];
      gaps.push({
        trace,
        prev: a.last.span,
        next: b.first.span,
        prevName: a.last.name,
        nextName: b.first.name,
        prevParallel: a.members.length,
        nextParallel: b.members.length,
        fromMs: a.endMs,
        toMs: b.startMs,
        gapMs: b.startMs - a.endMs,
      });
    }
  }
  gaps.sort((a, b) => a.fromMs - b.fromMs);
  gaps.forEach((g, i) => {
    g.index = i;
  });
  return {
    gaps,
    replaySkipped: replayStepExecutes(spans).length,
    steps: steps.length,
  };
}

/**
 * What ran inside a window, rolled up by name so a gap reads as a short list of
 * causes rather than hundreds of bars. `selfMs` is time not covered by a child,
 * which is what makes one row stand out as the actual cost.
 */
export function windowBreakdown(spans, fromMs, toMs, kids) {
  const overlap = (s) =>
    Math.max(0, Math.min(spanEnd(s), toMs) - Math.max(s.startMs, fromMs));
  const rows = new Map();
  for (const s of spans) {
    // Keep zero-duration spans that land on the boundary: an instant marker inside the
    // gap is exactly the kind of thing worth seeing, even though it contributes 0ms.
    if (spanEnd(s) < fromMs || s.startMs > toMs) continue;
    const inWin = overlap(s);
    let childCovered = 0;
    for (const c of kids.get(s.id) ?? []) childCovered += overlap(c);
    const key = compositeKey(s.service ?? '', s.name ?? '');
    const r = rows.get(key) ?? {
      name: s.name,
      service: s.service,
      scope: s.scope,
      count: 0,
      totalMs: 0,
      selfMs: 0,
      span: s,
    };
    r.count++;
    r.totalMs += inWin;
    r.selfMs += Math.max(0, inWin - childCovered);
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.selfMs - a.selfMs);
}
