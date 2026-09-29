----------------------------- MODULE ProbeCache -----------------------------
(***************************************************************************)
(* Timing abstraction of #4327's cross-deployment probe cache: ONE caller *)
(* process (one World), ONE target deployment + namespace, a sequence of  *)
(* start() calls to it. Answers the question the 29197a10f fix is about:  *)
(* is a target that CAN answer within the full probe budget eventually    *)
(* read correctly, or can it be stamped with the probe-miss fallback      *)
(* forever?                                                               *)
(*                                                                         *)
(* CODE MAP (workflow @ 29197a10f, packages/core/src/runtime/start.ts)    *)
(*  budget      69:  CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS = 10 s   *)
(*              76:  CROSS_DEPLOYMENT_PROBE_RETRY_TIMEOUT_MS = 2 s         *)
(*  AnswerTTL   84:  CROSS_DEPLOYMENT_PROBE_CACHE_TTL_MS = 10 min          *)
(*  MissTTL     93:  CROSS_DEPLOYMENT_PROBE_MISS_TTL_MS = 60 s             *)
(*  eviction    96, 315-318: 256 entries, oldest first (Evict action)      *)
(*  hit         285-290: entry.probe defined and younger than 10 min ->    *)
(*              reuse (key stripped; the stamp is the original one, Lean   *)
(*              Resolve.resolve_cache_hit)                                 *)
(*  recentMiss  291-294: entry is a miss younger than 60 s, computed with  *)
(*              `now` taken BEFORE the probe                                *)
(*  timeout     296-303: 2 s if recentMiss else 10 s                        *)
(*  answered    305: probe.format !== undefined (a reply of either format)  *)
(*  record      306-314: at = (!answered && recentMiss) ? entry.at          *)
(*              : Date.now() (AFTER the probe); probe = answered ? it :     *)
(*              undefined. Rule "refresh" is 4fbbbda45 (at = Date.now()    *)
(*              always), "firstMiss" is 29197a10f, "nocache" is 764eafd1a  *)
(*              (every start probes with 10 s).                            *)
(*  late answer helpers.ts:407-462: a reply after the deadline is on a     *)
(*              stream keyed by that probe's correlationId, which no later *)
(*              probe reads: it is lost, never cached.                     *)
(*                                                                         *)
(* ABSTRACTION                                                             *)
(*  Time in whole seconds. `age` = seconds since the entry's `at`, capped   *)
(*  at AgeCap (every age >= AnswerTTL behaves the same). Starts are        *)
(*  sequential: a Start runs its probe to completion, then Gap seconds     *)
(*  pass before the next start (Gaps = the inter-arrival times the traffic *)
(*  can have). The target's reply latency is Lat: fast (1 s, < 2 s), mid   *)
(*  (5 s, in (2 s, 10 s]) or never. Any probe may additionally miss for a  *)
(*  transient reason (queue error, a cold start longer than 10 s): at most *)
(*  MaxGlitches times in a behaviour, which is the fairness assumption     *)
(*  that "can answer within the budget" means.                             *)
(*  NOT MODELLED: concurrent starts to the same deployment (a miss that    *)
(*  finishes after a concurrent answer overwrites it with a miss entry;    *)
(*  under finitely many glitches this delays, never prevents, recovery),   *)
(*  a latency that changes over time other than by glitches.               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Rule,         \* "nocache" (764eafd1a) | "refresh" (4fbbbda45) | "firstMiss" (29197a10f)
    Lat,          \* "fast" | "mid" | "never"
    Gaps,         \* possible seconds between the end of a start's probe and the next start
    MaxGlitches,  \* transient misses allowed in a behaviour
    K,            \* bound for the safety surrogate NoLongFallbackRun
    EvictEnabled  \* the entry may be evicted (>= 256 other deployments probed)

FirstBudget == 10
RetryBudget == 2
MissTTL == 60
AnswerTTL == 600
AgeCap == AnswerTTL + 1
LatVal == CASE Lat = "fast" -> 1 [] Lat = "mid" -> 5 [] Lat = "never" -> 1000
CanAnswer == LatVal <= FirstBudget     \* answers within the full budget

Min(a, b) == IF a < b THEN a ELSE b

VARIABLES
    ent,       \* "none" | "ans" | "miss": the cache entry (probe defined / undefined)
    age,       \* seconds since entry.at (capped)
    glitches,  \* transient misses used so far
    last,      \* outcome of the latest start: "init" | "probe" | "cached" | "fallback"
    afb        \* consecutive avoidable fallback stamps since the last glitch (miss with no glitch
               \* on a target that answers within 10 s), capped at K + 1

vars == <<ent, age, glitches, last, afb>>

Init ==
    /\ ent = "none" /\ age = 0 /\ glitches = 0 /\ last = "init" /\ afb = 0

Hit == Rule # "nocache" /\ ent = "ans" /\ age < AnswerTTL
RecentMiss == Rule # "nocache" /\ ent = "miss" /\ age < MissTTL
Budget == IF RecentMiss THEN RetryBudget ELSE FirstBudget

Start ==
    \E g \in Gaps, glitch \in BOOLEAN :
      /\ glitch => glitches < MaxGlitches
      /\ IF Hit
         THEN /\ ~glitch
              /\ last' = "cached" /\ afb' = 0
              /\ ent' = ent /\ age' = Min(age + g, AgeCap)
              /\ glitches' = glitches
         ELSE LET answered == ~glitch /\ LatVal <= Budget
                  dur == IF answered THEN LatVal ELSE Budget
                  \* age of the new entry right after the probe returns
                  base == CASE answered -> 0
                            [] Rule = "firstMiss" /\ RecentMiss -> Min(age + dur, AgeCap)
                            [] OTHER -> 0
              IN /\ ent' = CASE Rule = "nocache" -> "none"
                             [] answered -> "ans"
                             [] OTHER -> "miss"
                 /\ age' = Min(base + g, AgeCap)
                 /\ last' = IF answered THEN "probe" ELSE "fallback"
                 /\ glitches' = IF glitch THEN glitches + 1 ELSE glitches
                 /\ afb' = CASE answered -> 0
                             [] ~glitch /\ CanAnswer -> Min(afb + 1, K + 1)
                             [] OTHER -> 0   \* a glitch explains this fallback: restart the count

Evict ==
    /\ EvictEnabled /\ ent # "none"
    /\ ent' = "none" /\ age' = 0
    /\ UNCHANGED <<glitches, last, afb>>

Next == Start \/ Evict

\* start() keeps being called (steady traffic); eviction is not forced
Spec == Init /\ [][Next]_vars /\ WF_vars(Start)

TypeOK ==
    /\ ent \in {"none", "ans", "miss"}
    /\ age \in 0..AgeCap
    /\ glitches \in 0..MaxGlitches
    /\ last \in {"init", "probe", "cached", "fallback"}
    /\ afb \in 0..(K + 1)

\* Safety surrogate: at most K consecutive fallback stamps that no glitch
\* explains, for a target that answers within the full budget.
NoLongFallbackRun == afb <= K

\* Liveness: a target that answers within the full budget is eventually
\* read correctly on every start (not stamped with the fallback forever).
EventuallyReadCorrectly ==
    CanAnswer => <>[](last \in {"probe", "cached"})

\* Weaker liveness: it is read correctly infinitely often.
InfinitelyOftenCorrect ==
    CanAnswer => []<>(last \in {"probe", "cached"})
=============================================================================
