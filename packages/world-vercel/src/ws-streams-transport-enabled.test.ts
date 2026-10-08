import { afterEach, describe, expect, it } from 'vitest';
import { isWsStreamsTransportEnabled } from './ws-transport-enabled.js';

afterEach(() => {
  delete process.env.WORKFLOW_STREAMS_TRANSPORT;
});

describe('isWsStreamsTransportEnabled', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['ws', true],
    ['WS', true],
    ['ws ', true],
    ['websocket', true],
    ['htp', true],
    ['http', false],
    ['HTTP', false],
    [' Http ', false],
    ['http\n', false],
  ])('uses WS unless the value is http: %j', (value, expected) => {
    if (value === undefined) {
      delete process.env.WORKFLOW_STREAMS_TRANSPORT;
    } else {
      process.env.WORKFLOW_STREAMS_TRANSPORT = value;
    }

    expect(isWsStreamsTransportEnabled()).toBe(expected);
  });
});
