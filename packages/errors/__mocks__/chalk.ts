// Mock implementation of the 'chalk' library for testing purposes.
// This mock wraps text in HTML-like tags to indicate styles because
// terminal styling is unreadable in test snapshots.

import type { ChalkInstance } from 'chalk';

const short = new Map([
  ['italic', 'i'],
  ['bold', 'b'],
]);

function createChalkMock(currentModifiers: string[] = []): ChalkInstance {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      return createChalkMock([...currentModifiers, short.get(prop) || prop]);
    },
    apply(_target, _thisArg, [text]) {
      return currentModifiers.reduceRight((acc, mod) => {
        const tag = String(mod);
        return `<${tag}>${acc}</${tag}>`;
      }, text as string);
    },
  }) as ChalkInstance;
}

export default createChalkMock();
