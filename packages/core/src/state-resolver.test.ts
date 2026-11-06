import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { StateContext, stateSourceId } from './serialization/state-refs.js';
import * as workflow from './serialization/workflow.js';
import { hydrateData, observabilityRevivers } from './serialization-format.js';
import { createStateResolver } from './state-resolver.js';

type Message = { role: string; content: string };

describe('createStateResolver', () => {
  it('rebuilds the actual input and output of a later step for inspection', () => {
    const body = new StateContext();
    const write = (value: unknown) =>
      workflow.serialize(value, { stateContext: body });
    const read = (bytes: Uint8Array) =>
      workflow.deserialize(bytes, { stateContext: body }) as any;

    const message = 'Weather in Oslo for the next three days, please. '.repeat(
      4
    );
    const hook = workflow.serialize(
      { message },
      { stateContext: new StateContext() }
    );
    const source = stateSourceId({
      eventType: 'hook_received',
      eventId: 'evnt_1',
    });
    body.addSource(source as string, read(hook));

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
    resolver.add(hook, source);
    for (const data of [output1, output2]) resolver.add(data);
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
  });

  it('rebuilds a whole value around a reference once the reference is added', () => {
    const body = new StateContext();
    const output1 = workflow.serialize(
      {
        inner: produce({ n: 0 }, (d) => {
          d.n = 1;
        }),
      },
      { stateContext: body }
    );
    const inner = (
      workflow.deserialize(output1, { stateContext: body }) as {
        inner: { n: number };
      }
    ).inner;
    // A new value holding the earlier one: stored whole, the inner one as a
    // reference.
    const outer = produce({ inner, label: 'a' }, (d) => {
      d.label = 'b';
    });
    const input2 = workflow.serialize({ outer }, { stateContext: body });

    const resolver = createStateResolver();
    const all = { ...observabilityRevivers, ...resolver.revivers };
    expect(
      (hydrateData(input2, all) as { outer: { inner: unknown } }).outer.inner
    ).toMatch(/^<workflow\/state /);
    resolver.add(output1);
    expect(hydrateData(input2, all)).toEqual({
      outer: { inner: { n: 1 }, label: 'b' },
    });
  });
});
