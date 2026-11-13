/-
OutputCodec: can the caller of a cross-deployment start read the run's
result? S7 (`MidRunRaiseGates/G3_StableCaller`, `Combined.race_stable_caller_into_v5wv`)
asks this about the compression FORMAT a stable caller knows. This file adds
the other half: the CODEC, which #4640 made depend on the Node.js version.

Code facts (workflow main, c07a6a395):
* The executor compresses the return value iff its in-memory
  `workflowRun.specVersion >= 5` (packages/core/src/workflow.ts:1282) and
  run errors likewise (runtime.ts:429). The codec is chosen from the
  EXECUTOR's own runtime: zstd when `node:zlib` has it (Node >= 22.15),
  else gzip (serialization/compression.ts:336-345, `selectWriteCodec`).
* A reader without zstd throws on a zstd payload ("requires Node.js 22.15+",
  compression.ts:264-272). gzip needs only CompressionStream (every v5 Node).
* #4640 (e71d1c767) records the EXECUTING deployment's Node version in
  `executionContext.nodeVersion` and gates zstd on it for writes INTO a run
  (cross-deployment arguments, hook payloads). Nothing records the CALLER's
  Node version, so the result written back to the caller is not gated.

So a v5 caller on Node 20 (an older deployment, a CLI or a dashboard server)
starting a run on a Node >= 22.15 deployment gets a result it cannot decode.
This is S7's shape at the codec level, and it does not need a raise: the
stamp alone (>= 5) enables compression.
-/

structure Reader where
  knowsCompression : Bool   -- v5 core (formats gzip/zstd known); stable: false
  hasZstd : Bool            -- node:zlib zstd (Node >= 22.15)
  deriving DecidableEq, Repr

inductive Codec | none | gzip | zstd
  deriving DecidableEq, Repr

/-- The codec the executor writes the return value with. -/
def resultCodec (runSpec : Nat) (execHasZstd : Bool) : Codec :=
  if runSpec ≥ 5 then (if execHasZstd then .zstd else .gzip) else .none

def decodes (r : Reader) : Codec → Bool
  | .none => true
  | .gzip => r.knowsCompression
  | .zstd => r.knowsCompression && r.hasZstd

/-- The proposed fix: record what the CALLER decodes on `run_created` (as
#4640 records the executor's Node version) and let the result honour it:
compress only if the caller knows compression, zstd only if it has zstd.
(With S7's fix, "knows compression" is the caller's stamp >= 5.) -/
def resultCodecFixed (runSpec : Nat) (execHasZstd : Bool) (caller : Reader) : Codec :=
  if runSpec ≥ 5 && caller.knowsCompression then
    (if execHasZstd && caller.hasZstd then .zstd else .gzip)
  else .none

def bools : List Bool := [false, true]
def readers : List Reader := bools.flatMap fun k => bools.map fun z => ⟨k, z⟩
def specs : List Nat := [3, 4, 5, 6, 7, 8]

/-- The as-is result is unreadable exactly when the executor writes zstd to a
v5 caller without zstd, or anything compressed to a stable caller (S7). -/
theorem asIs_unreadable_iff :
    (specs.all fun s => bools.all fun ez => readers.all fun r =>
      (!decodes r (resultCodec s ez)) ==
        (decide (s ≥ 5) && (!r.knowsCompression || (ez && !r.hasZstd)))) = true := by
  decide

/-- The codec half on its own: a v5 caller on Node 20 into a Node 24 target. -/
theorem node20_v5_caller_into_node24 :
    decodes ⟨true, false⟩ (resultCodec 8 true) = false := by decide

/-- With the caller's capabilities on the run, every result is readable by
its caller, whatever the run's spec and the executor's runtime. -/
theorem fixed_always_readable :
    (specs.all fun s => bools.all fun ez => readers.all fun r =>
      decodes r (resultCodecFixed s ez r)) = true := by
  decide

/-- The fix keeps compression whenever the as-is code would and the caller
can decode it: it does not give up zstd between two zstd runtimes. -/
theorem fixed_keeps_zstd :
    (specs.all fun s => resultCodecFixed s true ⟨true, true⟩ == resultCodec s true) = true := by
  decide

#eval specs.flatMap fun s => bools.flatMap fun ez => readers.filterMap fun r =>
  if decodes r (resultCodec s ez) then none
  else some s!"UNREADABLE spec={s} execZstd={ez} caller={repr r} codec={repr (resultCodec s ez)}"
