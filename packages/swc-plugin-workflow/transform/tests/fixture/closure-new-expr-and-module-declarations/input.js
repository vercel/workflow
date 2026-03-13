// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';

// Bug 1: `new` expressions should have their arguments captured as closure vars
export function mockModel(...args) {
  return async () => {
    'use step';
    return new MockLanguageModelV3(...args);
  };
}

// Regular function call for comparison (already worked before the fix)
export function xai(...args) {
  return async () => {
    'use step';
    return xaiProvider(...args);
  };
}

// Bug 3: Module-level function should NOT be captured as a closure variable.
// It should be available directly in the step bundle and removed by DCE
// from the workflow bundle since it's only used inside step bodies.
function mockProvider(...args) {
  return new MockLanguageModelV3(...args);
}

export function mockModelWrapped(...args) {
  return async () => {
    'use step';
    return mockProvider(...args);
  };
}

// Module-level variable should also NOT be captured as a closure variable.
const CONFIG = { timeout: 5000 };

export function configuredStep(url) {
  return async () => {
    'use step';
    return { url, config: CONFIG };
  };
}

// --- Additional expression patterns for closure variable coverage ---

// Optional chaining on a closure variable
export function withOptionalChaining(client) {
  return async () => {
    'use step';
    return client?.query();
  };
}

// Sequence expressions (comma operator)
export function withSequenceExpr(a, b) {
  return async () => {
    'use step';
    return (a, b);
  };
}

// Try/catch/finally referencing closure vars
export function withTryCatch(fn, fallback) {
  return async () => {
    'use step';
    try {
      return fn();
    } catch (err) {
      return fallback;
    }
  };
}

// Throw expression with closure var
export function withThrow(message) {
  return async () => {
    'use step';
    throw message;
  };
}

// Switch statement referencing closure vars
export function withSwitch(mode, a, b) {
  return async () => {
    'use step';
    switch (mode) {
      case 'add':
        return a + b;
      default:
        return a - b;
    }
  };
}

// For-of loop with closure var
export function withForOf(items, transform) {
  return async () => {
    'use step';
    const results = [];
    for (const item of items) {
      results.push(transform(item));
    }
    return results;
  };
}

// For-in loop with closure var
export function withForIn(obj) {
  return async () => {
    'use step';
    const keys = [];
    for (const key in obj) {
      keys.push(key);
    }
    return keys;
  };
}

// Do-while loop with closure var
export function withDoWhile(getNext) {
  return async () => {
    'use step';
    const results = [];
    let val;
    do {
      val = getNext();
      results.push(val);
    } while (val !== null);
    return results;
  };
}

// Object shorthand properties referencing closure vars
export function withShorthandProps(name, value) {
  return async () => {
    'use step';
    return { name, value, extra: 'literal' };
  };
}

// Computed property keys referencing closure vars
export function withComputedKey(key, value) {
  return async () => {
    'use step';
    return { [key]: value };
  };
}

// Bug 4: Deeply nested closure variable usage inside inner functions/methods.
// `text` is used inside start() method of ReadableStream constructor,
// which is nested several levels deep. Should still be captured.
export function mockTextModel(text) {
  return async () => {
    'use step';
    return mockProvider({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            for (const v of [
              { type: 'text-delta', delta: text },
            ]) c.enqueue(v);
            c.close();
          },
        }),
      }),
    });
  };
}

// Class expression bodies should detect closure vars from outer scope
export function withClassExpr(baseUrl) {
  return async () => {
    'use step';
    return new class {
      getUrl() {
        return baseUrl + '/api';
      }
    };
  };
}

// Class with super class referencing closure var
export function withClassSuper(Base) {
  return async () => {
    'use step';
    return class extends Base {
      getValue() {
        return 42;
      }
    };
  };
}

// Class property initializer referencing closure var
export function withClassProp(defaultValue) {
  return async () => {
    'use step';
    return new class {
      value = defaultValue;
    };
  };
}
