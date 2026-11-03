import { describe, expect, it } from 'vitest';
import { markStateSource, StateContext } from './serialization/state-refs.js';
import * as workflow from './serialization/workflow.js';
import { hydrateData, observabilityRevivers } from './serialization-format.js';
import { produce } from './state.js';
import { createStateResolver } from './state-resolver.js';

type Message = { role: string; content: string };

describe('createStateResolver', () => {
  it('rebuilds the actual input and output of a later step for inspection', () => {
    process.env.WORKFLOW_STATE_REFS = '1';
    try {
      const body = new StateContext();
      const write = (value: unknown) =>
        workflow.serialize(value, { stateContext: body });
      const read = (bytes: Uint8Array) =>
        workflow.deserialize(bytes, { stateContext: body }) as any;

      const message =
        'Weather in Oslo for the next three days, please. '.repeat(4);
      const payload = { message };
      markStateSource(payload, 'hook:1');
      const hook = workflow.serialize(payload, {
        stateContext: new StateContext(),
      });
      read(hook);

      const output1 = write({
        history: produce([] as Message[], (d) => {
          d.push(
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' }
          );
        }),
      });
      const v1 = read(output1).history;
      const input2 = write({ history: v1 });
      const output2 = write({
        history: produce(v1 as Message[], (d) => {
          d.push({ role: 'user', content: message });
        }),
      });

      const revivers = { ...observabilityRevivers };
      // Without the run's records, a reference is a placeholder.
      expect(hydrateData(input2, revivers)).toEqual({
        history: expect.stringMatching(/^<workflow\/state /),
      });

      const resolver = createStateResolver(revivers);
      // Hydrating before the records are added counts what was missing.
      hydrateData(input2, { ...revivers, ...resolver.revivers });
      expect(resolver.unresolved).toBe(1);
      for (const data of [hook, output1, output2]) resolver.add(data);
      const all = { ...revivers, ...resolver.revivers };
      expect(
        (hydrateData(input2, all) as { history: Message[] }).history
      ).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
      expect(
        (hydrateData(output2, all) as { history: Message[] }).history.at(-1)
      ).toEqual({
        role: 'user',
        content: message,
      });
      // Reusable across inspections without re-adding history.
      expect(
        (hydrateData(input2, all) as { history: Message[] }).history
      ).toHaveLength(2);
    } finally {
      delete process.env.WORKFLOW_STATE_REFS;
    }
  });

  it('ignores payloads it cannot read', () => {
    const resolver = createStateResolver();
    resolver.add('not a payload');
    resolver.add(new Uint8Array([1, 2, 3]));
    expect(
      resolver.revivers.StateRefV1({ kind: 'ref', logId: 'l', version: 'v9' })
    ).toBe('<workflow/state v9>');
  });

  it('rebuilds dates and byte arrays inside state without any revivers', () => {
    process.env.WORKFLOW_STATE_REFS = '1';
    try {
      const body = new StateContext();
      const write = (value: unknown) =>
        workflow.serialize(value, { stateContext: body });
      const read = (bytes: Uint8Array) =>
        workflow.deserialize(bytes, { stateContext: body }) as any;
      const output1 = write({
        state: produce(
          { at: new Date(5), bytes: new Uint8Array([1, 2]), list: [1] },
          (d) => {
            d.list.push(2);
          }
        ),
      });
      const input2 = write({ state: read(output1).state });

      const resolver = createStateResolver();
      resolver.add(output1);
      const shown = hydrateData(input2, resolver.revivers) as any;
      expect(resolver.unresolved).toBe(0);
      expect(shown.state.at).toEqual(new Date(5));
      expect(shown.state.bytes).toEqual(new Uint8Array([1, 2]));
      expect(shown.state.list).toEqual([1, 2]);
    } finally {
      delete process.env.WORKFLOW_STATE_REFS;
    }
  });
});
