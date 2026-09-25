import CrossDeploy.Spec
/-!
# CrossDeploy.Resolve — the client-side stamp (vercel/workflow#4327)

Pure model of `resolveCrossDeploymentSpecVersion` and of what a probe can return.

| Lean                       | Code (workflow @ 764eafd1a unless noted)                                                   |
|----------------------------|--------------------------------------------------------------------------------------------|
| `SpecField`, `ProbeObj`    | `HealthCheckResult` as built by `parseHealthCheckResponse`, packages/core/src/runtime/helpers.ts:307-360: non-JSON non-empty body -> `{healthy:true}` (our `plain := true`); JSON needs a boolean `healthy`; `specVersion` copied only when `typeof === 'number'` (a string is dropped -> `absent`; 7.5/NaN -> `nonInt`) |
| timeout / queue error      | `healthCheck` returns `{healthy:false, error}` (helpers.ts:307-460) -> `some ⟨false, absent, false⟩` |
| no probe channel (`none`)  | start.ts:504-523: cross-deployment start whose World has no `streams.get` calls `resolveCrossDeploymentSpecVersion(undefined, …)` |
| `validSpec`                | start.ts:122-126: `typeof === 'number' && Number.isInteger && >= 1`                        |
| `probeTarget`              | start.ts:117-138 branch order: valid spec -> it ('probe', even if `healthy` is false); else healthy -> 2 ('probe-unversioned'); else 6 ('probe-miss' / 'no-probe-channel') |
| `resolve p c`              | start.ts:137 `Math.min(target, callerSpecVersion)`; called at start.ts:522 and :548 with `world.specVersion` |
| `probeTargetProposed`      | the variant the #4327 TODO (start.ts:108-114) and the review propose: JSON-but-malformed version -> 3 (only spec>=3 responders reply JSON), miss floor 3 (relies on the #1044 raise to heal v5 targets); plain text stays 2 |
| `Reply`, `Net`, `probeOf`  | responders: v5 `handleHealthCheckMessage` helpers.ts:154-210 (JSON, `specVersion: worldSpecVersion ?? SPEC_VERSION_CURRENT`); stable helpers.ts:121-142 (JSON, 3); pre-3 plain text (comment helpers.ts:328-330) |

Theorems (all fully general, no bounded domain):
* `resolve_le_caller` : result ≤ c
* `resolve_json`      : a valid JSON version v gives exactly `min v c`
* `resolve_pos`       : c ≥ 1 → result ≥ 1
* `resolve_mono`      : monotone in c
* `resolve_le_target` : result ≤ what the probe implies
* the same four for the proposed variant, plus where the two variants differ.
-/
namespace CrossDeploy

/-- The `specVersion` field of a parsed health-check reply. -/
inductive SpecField where
  | absent
  | int (n : Int)
  | nonInt
deriving DecidableEq, Repr

/-- A parsed probe result (`HealthCheckResult`, restricted to the fields
`resolveCrossDeploymentSpecVersion` reads plus whether the body was plain text). -/
structure ProbeObj where
  healthy : Bool
  spec : SpecField
  plain : Bool
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

/-- Target version implied by a probe, as in start.ts:117-138 (before the `min`). -/
def probeTarget : Option ProbeObj → Nat
  | none => 6
  | some o =>
    match validSpec o.spec with
    | some v => v
    | none => if o.healthy then 2 else 6

/-- `resolveCrossDeploymentSpecVersion(probe, callerSpecVersion).specVersion`. -/
def resolve (p : Option ProbeObj) (c : Nat) : Nat := min (probeTarget p) c

/-- Proposed variant: JSON-malformed -> 3, miss floor 3, plain text -> 2. -/
def probeTargetProposed : Option ProbeObj → Nat
  | none => 3
  | some o =>
    match validSpec o.spec with
    | some v => v
    | none => if o.healthy && o.plain then 2 else 3

def resolveProposed (p : Option ProbeObj) (c : Nat) : Nat := min (probeTargetProposed p) c

/-! ## Current variant -/

theorem probeTarget_pos (p : Option ProbeObj) : 1 ≤ probeTarget p := by
  unfold probeTarget
  split
  · decide
  · split
    · rename_i v h; exact validSpec_pos h
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

/-- A JSON reply carrying version v from a JSON responder stamps `min v c`. -/
theorem resolve_json_reply (v c : Nat) (hv : 1 ≤ v) (b : Bool) :
    resolve (some ⟨b, .int v, false⟩) c = min v c :=
  resolve_json (validSpec_int hv) c

theorem resolve_plaintext (c : Nat) : resolve (some ⟨true, .absent, true⟩) c = min 2 c := rfl
theorem resolve_timeout (c : Nat) : resolve (some ⟨false, .absent, false⟩) c = min 6 c := rfl
theorem resolve_noChannel (c : Nat) : resolve none c = min 6 c := rfl
/-- A healthy JSON reply whose version is malformed is treated like plain text (2). -/
theorem resolve_malformed (c : Nat) : resolve (some ⟨true, .nonInt, false⟩) c = min 2 c := rfl

/-- For a v5 caller (World spec in [6, MAX], world-compatibility.ts:36-56) every miss stamps exactly 6. -/
theorem resolve_miss_v5 {c : Nat} (hc : 6 ≤ c) :
    resolve none c = 6 ∧ resolve (some ⟨false, .absent, false⟩) c = 6 := by
  simp [resolve, probeTarget, validSpec]; omega

/-! ## Proposed variant -/

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

/-- The two variants agree whenever the probe carries a valid version, and on plain text. -/
theorem variants_agree_on_valid {o : ProbeObj} {v : Nat} (h : validSpec o.spec = some v) (c : Nat) :
    resolve (some o) c = resolveProposed (some o) c := by
  rw [resolve_json h, resolveProposed_json h]

theorem variants_agree_on_plaintext (c : Nat) :
    resolve (some ⟨true, .absent, true⟩) c = resolveProposed (some ⟨true, .absent, true⟩) c := rfl

/-- Where they differ for a v5 caller: miss 6 vs 3, malformed JSON 2 vs 3. -/
theorem variants_differ_v5 {c : Nat} (hc : 6 ≤ c) :
    resolve none c = 6 ∧ resolveProposed none c = 3 ∧
    resolve (some ⟨true, .nonInt, false⟩) c = 2 ∧
    resolveProposed (some ⟨true, .nonInt, false⟩) c = 3 := by
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

/-- Whether the probe got an answer inside the 10 s budget (start.ts:64). -/
inductive Net where
  | answered
  | timeout
  | noChannel
deriving DecidableEq, Repr

def probeOf (r : Reply) : Net → Option ProbeObj
  | .answered =>
    match r with
    | .plaintext => some ⟨true, .absent, true⟩
    | .json v => some ⟨true, .int (v : Int), false⟩
    | .jsonMalformed => some ⟨true, .nonInt, false⟩
  | .timeout => some ⟨false, .absent, false⟩
  | .noChannel => none

end CrossDeploy
