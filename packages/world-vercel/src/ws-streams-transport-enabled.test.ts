import { afterEach, describe, expect, it } from 'vitest';
import {
  isWsStreamReadsTransportEnabled,
  isWsStreamsTransportEnabled,
} from './ws-transport-enabled.js';

afterEach(() => {
  delete process.env.WORKFLOW_STREAMS_TRANSPORT;
  delete process.env.WORKFLOW_STREAM_READS_TRANSPORT;
});

describe('isWsStreamsTransportEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['http', false],
    ['HTTP', false],
    ['ws ', false],
    ['WS', false],
    ['ws', true],
  ])('advertises v1 only for the exact ws value: %j', (value, expected) => {
    if (value === undefined) {
      delete process.env.WORKFLOW_STREAMS_TRANSPORT;
    } else {
      process.env.WORKFLOW_STREAMS_TRANSPORT = value;
    }

    expect(isWsStreamsTransportEnabled()).toBe(expected);
  });
});

describe('isWsStreamReadsTransportEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['http', false],
    ['WS', false],
    ['ws', true],
  ])('advertises read v1 only for the exact ws value: %j', (value, expected) => {
    if (value === undefined) {
      delete process.env.WORKFLOW_STREAM_READS_TRANSPORT;
    } else {
      process.env.WORKFLOW_STREAM_READS_TRANSPORT = value;
    }

    expect(isWsStreamReadsTransportEnabled()).toBe(expected);
  });
});
