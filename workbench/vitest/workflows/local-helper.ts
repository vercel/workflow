/**
 * Local helper module without workflow directives, imported by
 * local-deps.ts. Uses an enum on purpose: enums are not erasable
 * syntax, so Node's native type stripping cannot load this file if
 * it gets externalized from the step bundle instead of bundled
 * (regression test for vercel/workflow#2289).
 */
export enum PayloadKind {
  Recipe = 'recipe',
}

export function buildPayload(label: string) {
  return { label, kind: PayloadKind.Recipe };
}
