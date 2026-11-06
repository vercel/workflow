import CrossDeploy.Spec
/-!
# CrossDeploy.Resolve — the client-side stamp (vercel/workflow#4327)

Pure model of `resolveCrossDeploymentSpecVersion` and of what a probe can return,
at #4327 head **29197a10f** (origin/fix-cross-deploy-spec-version). The
764eafd1a version is kept as `resolve764` for the findings it produced.

| Lean                       | Code (workflow @ 29197a10f unless noted)                                                   |
|----------------------------|--------------------------------------------------------------------------------------------|
| `SpecField`, `ProbeObj`    | `HealthCheckResult` as built by `parseHealthCheckResponse`, packages/core/src/runtime/helpers.ts:311-367: non-JSON non-empty body -> `{healthy:true, format:'text'}`; JSON needs a boolean `healthy` and gets `format:'json'`; `specVersion` copied only when `typeof === 'number'` (a string is dropped -> `absent`; 7.5/NaN/0 -> `nonInt` / `int 0`) |
| `Fmt`                      | `HealthCheckResult.format` (helpers.ts:115-129), unset on a timeout or queue error (`noReply`) |
| timeout / queue error      | `healthCheck` returns `{healthy:false, error}` with no `format` (helpers.ts:452-462) -> `some ⟨false, absent, noReply⟩` |
| no probe channel (`none`)  | start.ts:630-638: a World without `streams.get` calls `resolveCrossDeploymentSpecVersion(undefined, …)` |
| `validSpec`                | start.ts:165-167: `typeof === 'number' && Number.isInteger && >= 1`                        |
| `probeTarget`              | start.ts:156-182 branch order: valid spec -> it; else `format === 'json'` -> 3 ('probe-malformed'); else healthy -> 2 ('probe-unversioned'); else 6 |
| `resolve p c`              | start.ts:181 `Math.min(target, callerSpecVersion)`; called at start.ts:638 and :663 with `world.specVersion` |
| probe cache                | start.ts:250-320 `probeCrossDeployment`: a cache hit returns the stored `HealthCheckResult` with only `encryptionPublicKey` cleared; `resolve` reads `healthy`/`specVersion`/`format` only, so a hit stamps exactly what the original answer stamped (`resolve_cache_hit`). WHEN a probe answers is modelled in the TLA+ StartStamping/ProbeCache.tla. |
| `resolve764`               | 764eafd1a start.ts:117-138: no format; a malformed JSON version fell through to 2          |
| `probeTargetProposed`      | the #4401 proposal on top of HEAD: miss floor 3 (relies on the #1044 raise to heal v5 targets) |
| `Reply`, `Net`, `probeOf`  | responders: v5 `handleHealthCheckMessage` helpers.ts:154-215 (JSON, `specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT`); stable (JSON, 3); pre-3 plain text |

Theorems (all fully general, no bounded domain):
* `resolve_le_caller`, `resolve_le_target`, `resolve_json`, `resolve_pos`, `resolve_mono`
* `resolve_malformed` : a JSON reply with no usable version stamps `min 3 c`, for
  either `healthy` value; `resolve_plaintext` 2; `resolve_timeout` / `noChannel` 6
* `resolve_json_ge3` : for a caller at ≥ 3 a JSON reply stamps ≥ 3 unless it
  carries a valid version below 3, so CBOR transport / resilient start are never
  lost to a malformed field
* `resolve_vs_764` : HEAD differs from 764eafd1a exactly on a JSON reply without a
  valid version (3 vs 2, or 3 vs 6 when it says `healthy:false`);
  `resolve_ge_764` : HEAD is never lower except on that `healthy:false` JSON reply
  (`resolve_lt_764_unhealthy_json`), which no in-repo responder sends
* the four for the proposed variant, and `variants_agree_off_miss` (HEAD and
  proposed now differ only on a miss)
-/
namespace CrossDeploy

/-- The `specVersion` field of a parsed health-check reply. -/
inductive SpecField where
  | absent
  | int (n : Int)
  | nonInt
deriving DecidableEq, Repr

/-- `HealthCheckResult.format` (29197a10f helpers.ts:115-129): set whenever the
responder answered, `'text'` for the pre-spec-3 plain-text body, `'json'`
otherwise; unset (`noReply`) on a timeout or queue error. -/
inductive Fmt where
  | noReply
  | json
  | text
deriving DecidableEq, Repr

/-- A parsed probe result (`HealthCheckResult`, restricted to the fields
`resolveCrossDeploymentSpecVersion` reads). -/
structure ProbeObj where
  healthy : Bool
  spec : SpecField
  fmt : Fmt
deriving DecidableEq, Repr

/-- start.ts:122-126. -/
def validSpec : SpecField → Option Nat
  | .int n => if 1 ≤ n then some n.toNat else none
  | _ => none

theorem validSpec_pos {s : SpecField} {v : Nat} (h : validSpec s = some v) : 1 ≤ v := by
  cases s with
  | int n =>
    simp only [validSpec] at h
    split at h
    · simp at h; omega
    · simp at h
  | absent => simp [validSpec] at h
  | nonInt => simp [validSpec] at h

theorem validSpec_int {v : Nat} (h : 1 ≤ v) : validSpec (.int (v : Int)) = some v := by
  simp [validSpec]; omega

/-- Target version implied by a probe at #4327 head 29197a10f, start.ts:156-182
(before the `min`): a valid version -> it ('probe', even if `healthy` is false);
else a JSON reply -> 3 ('probe-malformed', SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT);
else healthy (the plain-text reply) -> 2 ('probe-unversioned'); else 6
('probe-miss' / 'no-probe-channel'). -/
def probeTarget : Option ProbeObj → Nat
  | none => 6
  | some o =>
    match validSpec o.spec with
    | some v => v
    | none => if o.fmt == .json then 3 else if o.healthy then 2 else 6

/-- `resolveCrossDeploymentSpecVersion(probe, callerSpecVersion).specVersion` (HEAD). -/
def resolve (p : Option ProbeObj) (c : Nat) : Nat := min (probeTarget p) c

/-- The same function at 764eafd1a (start.ts:117-138), before the reply format
was reported: a JSON reply with a malformed version fell through to 2. -/
def probeTarget764 : Option ProbeObj → Nat
  | none => 6
  | some o =>
    match validSpec o.spec with
    | some v => v
    | none => if o.healthy then 2 else 6

def resolve764 (p : Option ProbeObj) (c : Nat) : Nat := min (probeTarget764 p) c

/-- Proposed variant (the #4401 floor drop): HEAD with miss floor 3. -/
def probeTargetProposed : Option ProbeObj → Nat
  | none => 3
  | some o =>
    match validSpec o.spec with
    | some v => v
    | none => if o.healthy && o.fmt == .text then 2 else 3

def resolveProposed (p : Option ProbeObj) (c : Nat) : Nat := min (probeTargetProposed p) c

/-! ## HEAD (29197a10f) -/

theorem probeTarget_pos (p : Option ProbeObj) : 1 ≤ probeTarget p := by
  unfold probeTarget
  split
  · decide
  · split
    · rename_i v h; exact validSpec_pos h
    · split
      · decide
      · split <;> decide

theorem resolve_le_caller (p : Option ProbeObj) (c : Nat) : resolve p c ≤ c :=
  Nat.min_le_right _ _

theorem resolve_le_target (p : Option ProbeObj) (c : Nat) : resolve p c ≤ probeTarget p :=
  Nat.min_le_left _ _

theorem resolve_json {o : ProbeObj} {v : Nat} (h : validSpec o.spec = some v) (c : Nat) :
    resolve (some o) c = min v c := by
  simp [resolve, probeTarget, h]

theorem resolve_pos (p : Option ProbeObj) {c : Nat} (hc : 1 ≤ c) : 1 ≤ resolve p c := by
  have := probeTarget_pos p
  unfold resolve; omega

theorem resolve_mono (p : Option ProbeObj) {c₁ c₂ : Nat} (h : c₁ ≤ c₂) :
    resolve p c₁ ≤ resolve p c₂ := by
  unfold resolve; omega

/-- A JSON reply carrying version v stamps `min v c` (whatever `healthy` says). -/
theorem resolve_json_reply (v c : Nat) (hv : 1 ≤ v) (b : Bool) :
    resolve (some ⟨b, .int v, .json⟩) c = min v c :=
  resolve_json (validSpec_int hv) c

theorem resolve_plaintext (c : Nat) : resolve (some ⟨true, .absent, .text⟩) c = min 2 c := rfl
theorem resolve_timeout (c : Nat) : resolve (some ⟨false, .absent, .noReply⟩) c = min 6 c := rfl
theorem resolve_noChannel (c : Nat) : resolve none c = min 6 c := rfl

/-- 'probe-malformed': a JSON reply without a valid version stamps `min 3 c`,
whether `healthy` is true or false and whatever the malformed field was
(absent, non-integer, or an integer < 1 such as 0). -/
theorem resolve_malformed (b : Bool) (s : SpecField) (hs : validSpec s = none) (c : Nat) :
    resolve (some ⟨b, s, .json⟩) c = min 3 c := by
  simp [resolve, probeTarget, hs]

/-- Every JSON reply stamps ≥ 3 for a caller at ≥ 3: a JSON responder is spec ≥ 3,
and a malformed field no longer costs the run CBOR transport (and resilient start). -/
theorem resolve_json_ge3 (b : Bool) (s : SpecField) {c : Nat} (hc : 3 ≤ c) :
    3 ≤ resolve (some ⟨b, s, .json⟩) c ∨ ∃ v, validSpec s = some v ∧ v < 3 ∧
      resolve (some ⟨b, s, .json⟩) c = v := by
  cases h : validSpec s with
  | none => left; rw [resolve_malformed b s h]; omega
  | some v =>
    rw [resolve_json (o := ⟨b, s, .json⟩) h]
    by_cases hv : 3 ≤ v
    · left; omega
    · right; exact ⟨v, rfl, by omega, by omega⟩

/-- For a v5 caller (World spec in [6, MAX], world-compatibility.ts:36-56) every miss stamps exactly 6. -/
theorem resolve_miss_v5 {c : Nat} (hc : 6 ≤ c) :
    resolve none c = 6 ∧ resolve (some ⟨false, .absent, .noReply⟩) c = 6 := by
  simp [resolve, probeTarget, validSpec]; omega

/-- A cache hit (start.ts:274-320) hands `resolve` the stored answer with only
`encryptionPublicKey` cleared. `resolve` does not read the key (its argument
type is `Pick<HealthCheckResult, 'healthy' | 'specVersion' | 'format'>`), and
`ProbeObj` carries exactly those fields, so the stamp from a hit is the stamp
the original answer gave. Stated over an explicit key field to make the
independence visible. -/
theorem resolve_cache_hit (o : ProbeObj) (_keyOriginal _keyStripped : Option String) (c : Nat) :
    (fun (_k : Option String) => resolve (some o) c) _keyOriginal =
    (fun (_k : Option String) => resolve (some o) c) _keyStripped := rfl

/-! ## HEAD vs 764eafd1a -/

theorem resolve764_malformed (c : Nat) : resolve764 (some ⟨true, .nonInt, .json⟩) c = min 2 c := rfl

/-- HEAD and 764eafd1a differ exactly on a JSON reply with no valid version. -/
theorem resolve_vs_764 (p : Option ProbeObj) (c : Nat) :
    resolve p c ≠ resolve764 p c →
      ∃ o, p = some o ∧ validSpec o.spec = none ∧ o.fmt = .json := by
  intro h
  cases p with
  | none => exact absurd rfl h
  | some o =>
    refine ⟨o, rfl, ?_⟩
    cases hv : validSpec o.spec with
    | some v => simp [resolve, resolve764, probeTarget, probeTarget764, hv] at h
    | none =>
      refine ⟨rfl, ?_⟩
      cases hf : o.fmt <;> simp_all [resolve, resolve764, probeTarget, probeTarget764]

/-- HEAD never stamps lower than 764eafd1a for a v5 caller (c ≥ 3), EXCEPT on a
JSON reply that says `healthy: false` and carries no valid version: 764eafd1a
treated that as a miss (6), HEAD stamps it 3 ('probe-malformed'). No in-repo
responder sends `healthy: false` (helpers.ts:199-208 always writes `true`). -/
theorem resolve_ge_764 (p : Option ProbeObj) {c : Nat} (hc : 3 ≤ c)
    (hnot : ∀ o, p = some o → validSpec o.spec = none → o.fmt = .json → o.healthy = true) :
    resolve764 p c ≤ resolve p c := by
  cases p with
  | none => simp [resolve, resolve764, probeTarget, probeTarget764]
  | some o =>
    cases hv : validSpec o.spec with
    | some v => simp [resolve, resolve764, probeTarget, probeTarget764, hv]
    | none =>
      have hn := hnot o rfl hv
      cases hf : o.fmt <;> cases hh : o.healthy <;>
        simp_all [resolve, resolve764, probeTarget, probeTarget764] <;> omega

/-- The exception is real: `{healthy:false, format:'json'}` without a version. -/
theorem resolve_lt_764_unhealthy_json {c : Nat} (hc : 6 ≤ c) :
    resolve (some ⟨false, .absent, .json⟩) c = 3 ∧
    resolve764 (some ⟨false, .absent, .json⟩) c = 6 := by
  simp [resolve, resolve764, probeTarget, probeTarget764, validSpec]; omega

/-! ## Proposed variant (#4401: miss floor 3 on top of HEAD) -/

theorem probeTargetProposed_pos (p : Option ProbeObj) : 1 ≤ probeTargetProposed p := by
  unfold probeTargetProposed
  split
  · decide
  · split
    · rename_i v h; exact validSpec_pos h
    · split <;> decide

theorem resolveProposed_le_caller (p : Option ProbeObj) (c : Nat) : resolveProposed p c ≤ c :=
  Nat.min_le_right _ _

theorem resolveProposed_json {o : ProbeObj} {v : Nat} (h : validSpec o.spec = some v) (c : Nat) :
    resolveProposed (some o) c = min v c := by
  simp [resolveProposed, probeTargetProposed, h]

theorem resolveProposed_pos (p : Option ProbeObj) {c : Nat} (hc : 1 ≤ c) : 1 ≤ resolveProposed p c := by
  have := probeTargetProposed_pos p
  unfold resolveProposed; omega

theorem resolveProposed_mono (p : Option ProbeObj) {c₁ c₂ : Nat} (h : c₁ ≤ c₂) :
    resolveProposed p c₁ ≤ resolveProposed p c₂ := by
  unfold resolveProposed; omega

theorem variants_agree_on_valid {o : ProbeObj} {v : Nat} (h : validSpec o.spec = some v) (c : Nat) :
    resolve (some o) c = resolveProposed (some o) c := by
  rw [resolve_json h, resolveProposed_json h]

/-- On every ANSWERED probe (`fmt ≠ noReply`, i.e. the responder replied: parse
always sets `healthy := true` on text) HEAD and the proposed variant agree;
they differ only on a miss / no channel (6 vs 3). -/
theorem variants_agree_off_miss (o : ProbeObj) (hf : o.fmt ≠ .noReply)
    (htext : o.fmt = .text → o.healthy = true) (c : Nat) :
    resolve (some o) c = resolveProposed (some o) c := by
  cases hv : validSpec o.spec with
  | some v => exact variants_agree_on_valid hv c
  | none =>
    cases hfm : o.fmt with
    | noReply => exact absurd hfm hf
    | json => simp [resolve, resolveProposed, probeTarget, probeTargetProposed, hv, hfm]
    | text =>
      have := htext hfm
      simp [resolve, resolveProposed, probeTarget, probeTargetProposed, hv, hfm, this]

theorem variants_differ_v5 {c : Nat} (hc : 6 ≤ c) :
    resolve none c = 6 ∧ resolveProposed none c = 3 ∧
    resolve (some ⟨false, .absent, .noReply⟩) c = 6 ∧
    resolveProposed (some ⟨false, .absent, .noReply⟩) c = 3 := by
  simp [resolve, resolveProposed, probeTarget, probeTargetProposed, validSpec]; omega

/-! ## What a target can answer -/

/-- What a deployment's health-check responder writes when reached. -/
inductive Reply where
  /-- pre-spec-3 deployment: plain-text body. -/
  | plaintext
  /-- JSON with an integer version (v5 and stable responders). -/
  | json (reported : Nat)
  /-- JSON with a malformed version (not produced by the in-repo responders; a community World). -/
  | jsonMalformed
deriving DecidableEq, Repr

/-- Whether the probe got an answer inside its budget (10 s first probe, 2 s after a recent miss: start.ts:70-96; timing in StartStamping/ProbeCache.tla). -/
inductive Net where
  | answered
  | timeout
  | noChannel
deriving DecidableEq, Repr

def probeOf (r : Reply) : Net → Option ProbeObj
  | .answered =>
    match r with
    | .plaintext => some ⟨true, .absent, .text⟩
    | .json v => some ⟨true, .int (v : Int), .json⟩
    | .jsonMalformed => some ⟨true, .nonInt, .json⟩
  | .timeout => some ⟨false, .absent, .noReply⟩
  | .noChannel => none

end CrossDeploy
