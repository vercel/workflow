import { gunzipSync } from 'node:zlib';

/**
 * A line-splice patch against the decoded reference bundle. Ops apply to the
 * reference's line array (as split by splitLines) in ascending, in-order
 * positions: delete `deleteCount` lines at `start`, then insert `lines`.
 * The builder verifies at build time that applying a patch reproduces the
 * original shard byte-for-byte; any shard that cannot be encoded this way is
 * stored verbatim in `bundles` instead.
 */
export interface WorkflowBundlePatchOp {
  readonly start: number;
  readonly deleteCount: number;
  readonly lines: readonly string[];
}

interface ShardedWorkflowCode {
  readonly bundles: Readonly<Record<string, string>>;
  readonly workflowBundles: Readonly<Record<string, string>>;
  readonly encoding?: 'gzip-base64';
  /**
   * Delta-encoded shards: `reference` names the bundle key (present in
   * `bundles`) whose decoded text the patches splice, and `patches` maps a
   * bundle key to its ops. Shard bundles differ only in their workflow source
   * section — the ~19k lines of shared runtime scaffolding are identical — so
   * this stores the shared text once instead of once per workflow.
   */
  readonly reference?: string;
  readonly patches?: Readonly<Record<string, readonly WorkflowBundlePatchOp[]>>;
}

export type WorkflowCode =
  | string
  | Readonly<Record<string, string>>
  | ShardedWorkflowCode;

// A builder/watch process may reuse the decoded-bundle map while replacing the
// generated workflow object. Bundle keys are deterministic (`bundle-0`, ...),
// so keying the cache by bundle name alone could otherwise return a shard from
// the previous successful build after a failed/then-successful rebuild.
const decodedBundleOwners = new WeakMap<Map<string, string>, object>();

function isShardedWorkflowCode(
  workflowCode: Readonly<Record<string, string>> | ShardedWorkflowCode
): workflowCode is ShardedWorkflowCode {
  return 'bundles' in workflowCode && 'workflowBundles' in workflowCode;
}

/**
 * Splits on '\n' while keeping each separator attached to its line, so
 * joining with '' is the exact inverse for any input (including no trailing
 * newline). Both the builder's encoder and this runtime applier must use the
 * same definition.
 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (index < lines.length - 1) {
      out.push(`${lines[index]}\n`);
    } else if (lines[index] !== '') {
      out.push(lines[index]);
    }
  }
  return out;
}

export function applyBundlePatch(
  referenceLines: readonly string[],
  ops: readonly WorkflowBundlePatchOp[]
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const op of ops) {
    for (let index = cursor; index < op.start; index++) {
      parts.push(referenceLines[index]);
    }
    parts.push(...op.lines);
    cursor = op.start + op.deleteCount;
  }
  for (let index = cursor; index < referenceLines.length; index++) {
    parts.push(referenceLines[index]);
  }
  return parts.join('');
}

function decodeBundleText(encoded: string, gzip: boolean): string {
  return gzip ? gunzipSync(Buffer.from(encoded, 'base64')).toString() : encoded;
}

export function selectWorkflowCode(
  workflowCode: WorkflowCode,
  workflowName: string,
  decodedBundles: Map<string, string>
): string | undefined {
  if (typeof workflowCode === 'string') return workflowCode;

  if (isShardedWorkflowCode(workflowCode)) {
    const previousOwner = decodedBundleOwners.get(decodedBundles);
    if (previousOwner !== workflowCode) {
      decodedBundles.clear();
      decodedBundleOwners.set(decodedBundles, workflowCode);
    }

    const bundleKey = workflowCode.workflowBundles[workflowName];
    if (bundleKey === undefined) return undefined;

    const gzip = workflowCode.encoding === 'gzip-base64';
    const cached = decodedBundles.get(bundleKey);
    if (cached !== undefined) return cached;

    const encoded = workflowCode.bundles[bundleKey];
    if (encoded !== undefined) {
      const decoded = decodeBundleText(encoded, gzip);
      decodedBundles.set(bundleKey, decoded);
      return decoded;
    }

    const ops = workflowCode.patches?.[bundleKey];
    const referenceKey = workflowCode.reference;
    if (ops === undefined || referenceKey === undefined) return undefined;
    const referenceEncoded = workflowCode.bundles[referenceKey];
    if (referenceEncoded === undefined) return undefined;
    let referenceText = decodedBundles.get(referenceKey);
    if (referenceText === undefined) {
      referenceText = decodeBundleText(referenceEncoded, gzip);
      decodedBundles.set(referenceKey, referenceText);
    }
    // The patch application runs once per bundle key per process; the result
    // is cached above, so re-splitting the reference here stays cold-path.
    const decoded = applyBundlePatch(splitLines(referenceText), ops);
    decodedBundles.set(bundleKey, decoded);
    return decoded;
  }

  return workflowCode[workflowName];
}
