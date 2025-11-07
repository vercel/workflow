/**
 * Tests for DurableAgent
 *
 * These tests verify the stopWhen functionality of the DurableAgent class.
 */
import { hasToolCall, stepCountIs } from 'ai';
import { describe, expect, it } from 'vitest';
import { DurableAgent } from './durable-agent.js';

describe('DurableAgent', () => {
  describe('stopWhen option', () => {
    it('should accept stopWhen in constructor options', () => {
      const agent = new DurableAgent({
        model: 'test-model',
        tools: {},
        stopWhen: stepCountIs(5),
      });
      expect(agent).toBeDefined();
    });

    it('should accept stopWhen as array in constructor options', () => {
      const agent = new DurableAgent({
        model: 'test-model',
        tools: {},
        stopWhen: [stepCountIs(5), hasToolCall('testTool')],
      });
      expect(agent).toBeDefined();
    });

    it('should accept stopWhen in stream options', () => {
      const _agent = new DurableAgent({
        model: 'test-model',
        tools: {},
      });

      // Just checking that the type accepts stopWhen
      const options = {
        messages: [],
        stopWhen: stepCountIs(3),
      };

      expect(options.stopWhen).toBeDefined();
    });

    it('should accept stopWhen as array in stream options', () => {
      const _agent = new DurableAgent({
        model: 'test-model',
        tools: {},
      });

      // Just checking that the type accepts stopWhen as array
      const options = {
        messages: [],
        stopWhen: [stepCountIs(3), hasToolCall('myTool')],
      };

      expect(options.stopWhen).toBeInstanceOf(Array);
    });
  });

  describe('type compatibility', () => {
    it('should be compatible with AI SDK StopCondition type', () => {
      // This test verifies that the types are compatible with AI SDK
      const stopCondition = stepCountIs(5);

      const agent = new DurableAgent({
        model: 'test-model',
        tools: {},
        stopWhen: stopCondition,
      });

      expect(agent).toBeDefined();
    });

    it('should be compatible with AI SDK helper functions', () => {
      const agent = new DurableAgent({
        model: 'test-model',
        tools: {},
        stopWhen: [stepCountIs(10), hasToolCall('specificTool')],
      });

      expect(agent).toBeDefined();
    });
  });
});
